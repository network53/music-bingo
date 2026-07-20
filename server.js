const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_ROOT = path.join(PUBLIC_DIR, 'uploads');
const LIBRARY_FILE = path.join(__dirname, 'library.json');

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

app.use(express.static(PUBLIC_DIR));
app.use(express.json());

// ---------- Song library persistence ----------
// library.json shape: { [slug]: { name: "New Year", songs: [{title, url}] } }
function loadLibrary() {
  try {
    return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveLibrary(lib) {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2));
}
function slugify(name) {
  const s = (name || '').trim().toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'folder';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT, req.params.slug);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const safe = Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(file.originalname);
      cb(null, safe);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.get('/api/library', (req, res) => {
  const lib = loadLibrary();
  const out = {};
  for (const slug in lib) out[slug] = { name: lib[slug].name, count: lib[slug].songs.length };
  res.json(out);
});

app.get('/api/library/:slug', (req, res) => {
  const lib = loadLibrary();
  const folder = lib[req.params.slug];
  if (!folder) return res.status(404).json({ error: 'Папка не найдена.' });
  res.json({ name: folder.name, songs: folder.songs });
});

app.post('/api/library/folder', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название папки.' });
  const slug = slugify(name);
  const lib = loadLibrary();
  if (!lib[slug]) lib[slug] = { name, songs: [] };
  saveLibrary(lib);
  res.json({ slug, name: lib[slug].name });
});

app.post('/api/library/:slug/upload', upload.array('songs', 200), (req, res) => {
  const slug = req.params.slug;
  const lib = loadLibrary();
  if (!lib[slug]) lib[slug] = { name: req.body.folderName || slug, songs: [] };
  const added = (req.files || []).map((f) => ({
    title: path.parse(f.originalname).name.replace(/[_\-]+/g, ' ').trim(),
    url: '/uploads/' + slug + '/' + f.filename
  }));
  lib[slug].songs.push(...added);
  saveLibrary(lib);
  res.json({ added, total: lib[slug].songs.length });
});

app.delete('/api/library/:slug/song', (req, res) => {
  const { url } = req.body;
  const lib = loadLibrary();
  const folder = lib[req.params.slug];
  if (!folder) return res.status(404).json({ error: 'Папка не найдена.' });
  folder.songs = folder.songs.filter((s) => s.url !== url);
  saveLibrary(lib);
  if (url) {
    const filePath = path.join(PUBLIC_DIR, url.replace(/^\//, ''));
    fs.unlink(filePath, () => {});
  }
  res.json({ ok: true });
});

app.delete('/api/library/:slug', (req, res) => {
  const lib = loadLibrary();
  if (!lib[req.params.slug]) return res.status(404).json({ error: 'Папка не найдена.' });
  delete lib[req.params.slug];
  saveLibrary(lib);
  fs.rm(path.join(UPLOAD_ROOT, req.params.slug), { recursive: true, force: true }, () => {});
  res.json({ ok: true });
});

// ---------- Live games (in-memory, ephemeral) ----------
// code -> {
//   songs: [{title,url}], revealed: string[],
//   players: Map(socketId -> {name, cardTitles, marks, size, freeIndex}),
//   winner, pendingClaim: {socketId, name} | null, createdAt
// }
const games = new Map();

setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [code, game] of games) {
    if (game.createdAt < cutoff) games.delete(code);
  }
}, 60 * 60 * 1000);

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return games.has(c) ? genCode() : c;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function gridSizeFor(n) {
  if (n >= 24) return 5;
  if (n >= 16) return 4;
  if (n >= 9) return 3;
  return 0;
}
function playersPayload(game) {
  return {
    count: game.players.size,
    names: Array.from(game.players.values()).map((p) => p.name)
  };
}
function newGame(songs) {
  const code = genCode();
  games.set(code, {
    songs,
    revealed: [],
    players: new Map(),
    winner: null,
    pendingClaim: null,
    createdAt: Date.now()
  });
  return code;
}
function checkBingoServer(marks, size) {
  for (let r = 0; r < size; r++) {
    let row = true, col = true;
    for (let c = 0; c < size; c++) {
      if (!marks[r * size + c]) row = false;
      if (!marks[c * size + r]) col = false;
    }
    if (row || col) return true;
  }
  let d1 = true, d2 = true;
  for (let i = 0; i < size; i++) {
    if (!marks[i * size + i]) d1 = false;
    if (!marks[i * size + (size - 1 - i)]) d2 = false;
  }
  return d1 || d2;
}

io.on('connection', (socket) => {
  socket.on('create_game', (songs, cb) => {
    if (!Array.isArray(songs) || songs.length < 9) {
      return cb({ error: 'Нужно минимум 9 песен.' });
    }
    const code = newGame(songs);
    socket.join(code);
    cb({ code, songs: games.get(code).songs });
  });

  socket.on('create_game_from_folder', ({ slug, count }, cb) => {
    const lib = loadLibrary();
    const folder = lib[slug];
    if (!folder) return cb({ error: 'Папка не найдена.' });
    if (folder.songs.length < 9) return cb({ error: 'В папке меньше 9 песен.' });
    const n = Math.max(9, Math.min(count || folder.songs.length, folder.songs.length));
    const chosen = shuffle(folder.songs).slice(0, n);
    const code = newGame(chosen);
    socket.join(code);
    cb({ code, songs: games.get(code).songs });
  });

  socket.on('host_rejoin', (code, cb) => {
    const game = games.get(code);
    if (!game) return cb({ error: 'Игра не найдена (возможно, истекла).' });
    socket.join(code);
    cb({
      songs: game.songs,
      revealed: game.revealed,
      winner: game.winner,
      playerCount: game.players.size,
      pendingClaim: game.pendingClaim ? { name: game.pendingClaim.name } : null
    });
  });

  socket.on('join_game', (code, name, cb) => {
    const game = games.get(code);
    if (!game) return cb({ error: 'Игра с таким кодом не найдена.' });
    const size = gridSizeFor(game.songs.length);
    if (size === 0) return cb({ error: 'В этой игре пока маловато песен для карточки.' });
    socket.join(code);

    const total = size * size;
    const freeIndex = size % 2 === 1 ? Math.floor(total / 2) : -1;
    let player = game.players.get(socket.id);
    if (!player) {
      const cardTitles = shuffle(game.songs.map((s) => s.title)).slice(0, total);
      const marks = new Array(total).fill(false);
      if (freeIndex >= 0) marks[freeIndex] = true;
      player = { name: (name || 'Игрок').slice(0, 30), cardTitles, marks, size, freeIndex };
      game.players.set(socket.id, player);
    } else if (name) {
      player.name = name.slice(0, 30);
    }
    io.to(code).emit('players_update', playersPayload(game));
    cb({
      cardTitles: player.cardTitles,
      marks: player.marks,
      size: player.size,
      freeIndex: player.freeIndex,
      revealed: game.revealed,
      winner: game.winner,
      totalSongs: game.songs.length
    });
  });

  socket.on('toggle_mark', (code, index) => {
    const game = games.get(code);
    if (!game || game.winner) return;
    const player = game.players.get(socket.id);
    if (!player) return;
    if (index === player.freeIndex || index < 0 || index >= player.cardTitles.length) return;
    const title = player.cardTitles[index];
    if (!game.revealed.includes(title)) return; // can only mark songs that have actually played
    player.marks[index] = !player.marks[index];
    socket.emit('mark_update', { marks: player.marks });
  });

  socket.on('reveal_next', (code, cb) => {
    const game = games.get(code);
    if (!game) return cb({ error: 'Игра не найдена.' });
    const remaining = game.songs.filter((s) => !game.revealed.includes(s.title));
    if (remaining.length === 0) return cb({ error: 'Все песни уже сыграны.' });
    const pick = remaining[Math.floor(Math.random() * remaining.length)];
    game.revealed.push(pick.title);
    io.to(code).emit('game_update', { revealed: game.revealed, currentSong: pick });
    cb({ ok: true, revealed: game.revealed, currentSong: pick });
  });

  socket.on('reset_game', (code, cb) => {
    const game = games.get(code);
    if (!game) return cb && cb({ error: 'Игра не найдена.' });
    game.revealed = [];
    game.winner = null;
    game.pendingClaim = null;
    for (const player of game.players.values()) {
      player.marks = new Array(player.cardTitles.length).fill(false);
      if (player.freeIndex >= 0) player.marks[player.freeIndex] = true;
    }
    io.to(code).emit('game_update', { revealed: [], currentSong: null });
    io.to(code).emit('winner_update', { winner: null });
    io.to(code).emit('bingo_claim_cleared', {});
    cb && cb({ ok: true });
  });

  // Player calls bingo -> host gets a verify prompt -> auto-checked when host confirms
  socket.on('claim_bingo', (code) => {
    const game = games.get(code);
    if (!game || game.winner || game.pendingClaim) return;
    const player = game.players.get(socket.id);
    if (!player) return;
    game.pendingClaim = { socketId: socket.id, name: player.name };
    io.to(code).emit('bingo_claim', { name: player.name });
  });

  socket.on('verify_bingo', (code, cb) => {
    const game = games.get(code);
    if (!game || !game.pendingClaim) return cb && cb({ error: 'Нет активной заявки.' });
    const claim = game.pendingClaim;
    const player = game.players.get(claim.socketId);
    const valid = player ? checkBingoServer(player.marks, player.size) : false;
    game.pendingClaim = null;
    if (valid) {
      game.winner = claim.name;
      io.to(code).emit('winner_update', { winner: game.winner });
    } else {
      io.to(code).emit('bingo_claim_cleared', {});
      io.to(claim.socketId).emit('bingo_rejected', {});
    }
    cb && cb({ ok: true, valid });
  });

  socket.on('disconnect', () => {
    for (const [code, game] of games.entries()) {
      if (game.players.delete(socket.id)) {
        io.to(code).emit('players_update', playersPayload(game));
      }
      if (game.pendingClaim && game.pendingClaim.socketId === socket.id) {
        game.pendingClaim = null;
        io.to(code).emit('bingo_claim_cleared', {});
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Music Bingo server listening on port ' + PORT));
