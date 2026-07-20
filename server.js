const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_ROOT = path.join(PUBLIC_DIR, 'uploads');
const LIBRARY_FILE = path.join(__dirname, 'library.json');
const GAMES_FILE = path.join(__dirname, 'games-history.json');

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

app.use(express.static(PUBLIC_DIR));
app.use(express.json());

// ============================================================
// LIBRARY
// ============================================================
function loadLibrary() {
  try { return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveLibrary(lib) { fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2)); }
function slugify(name) {
  const s = (name || '').trim().toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '_').replace(/^_+|_+$/g, '');
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
  limits: { fileSize: 50 * 1024 * 1024 }
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

app.post('/api/library/:slug/upload', upload.array('songs', 500), (req, res) => {
  const slug = req.params.slug;
  const lib = loadLibrary();
  if (!lib[slug]) lib[slug] = { name: req.body.folderName || slug, songs: [] };
  const added = (req.files || []).map((f) => ({
    title: path.parse(f.originalname).name.replace(/[_\-]+/g, ' ').trim(),
    artist: '',
    url: '/uploads/' + slug + '/' + f.filename,
    duration: 0
  }));
  lib[slug].songs.push(...added);
  saveLibrary(lib);
  res.json({ added, total: lib[slug].songs.length });
});

app.post('/api/library/:slug/song-info', (req, res) => {
  const { url, title, artist, duration } = req.body;
  const lib = loadLibrary();
  const folder = lib[req.params.slug];
  if (!folder) return res.status(404).json({ error: 'Папка не найдена.' });
  const song = folder.songs.find(s => s.url === url);
  if (song) {
    if (title !== undefined) song.title = title;
    if (artist !== undefined) song.artist = artist;
    if (duration !== undefined) song.duration = duration;
    saveLibrary(lib);
  }
  res.json({ ok: true });
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

// ============================================================
// GAMES ENGINE
// ============================================================

// BINGO PATTERNS (Targets)
const PATTERNS = {
  '1line': { name: '1 Line', check: (marks, size) => checkLines(marks, size, 1) },
  '2lines': { name: '2 Lines', check: (marks, size) => checkLines(marks, size, 2) },
  '3lines': { name: '3 Lines', check: (marks, size) => checkLines(marks, size, 3) },
  '4lines': { name: '4 Lines', check: (marks, size) => checkLines(marks, size, 4) },
  'fullhouse': { name: 'Full House', check: (marks, size) => checkFullHouse(marks, size) },
  'corners': { name: '4 Corners', check: (marks, size) => checkCorners(marks, size) },
  'cross': { name: 'Cross', check: (marks, size) => checkCross(marks, size) },
  'outer': { name: 'Outer Frame', check: (marks, size) => checkOuter(marks, size) },
  'letterX': { name: 'Letter X', check: (marks, size) => checkX(marks, size) },
};

function checkLines(marks, size, needed) {
  let lines = 0;
  // rows
  for (let r = 0; r < size; r++) {
    let ok = true;
    for (let c = 0; c < size; c++) if (!marks[r * size + c]) ok = false;
    if (ok) lines++;
  }
  // cols
  for (let c = 0; c < size; c++) {
    let ok = true;
    for (let r = 0; r < size; r++) if (!marks[r * size + c]) ok = false;
    if (ok) lines++;
  }
  return lines >= needed;
}
function checkFullHouse(marks, size) {
  for (let i = 0; i < marks.length; i++) if (!marks[i]) return false;
  return true;
}
function checkCorners(marks, size) {
  if (size < 3) return false;
  return marks[0] && marks[size - 1] && marks[size * (size - 1)] && marks[size * size - 1];
}
function checkCross(marks, size) {
  if (size < 3) return false;
  const mid = Math.floor(size / 2);
  let rowOk = true, colOk = true;
  for (let i = 0; i < size; i++) {
    if (!marks[mid * size + i]) rowOk = false;
    if (!marks[i * size + mid]) colOk = false;
  }
  return rowOk && colOk;
}
function checkOuter(marks, size) {
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (r === 0 || r === size - 1 || c === 0 || c === size - 1) {
        if (!marks[r * size + c]) return false;
      }
    }
  }
  return true;
}
function checkX(marks, size) {
  let d1 = true, d2 = true;
  for (let i = 0; i < size; i++) {
    if (!marks[i * size + i]) d1 = false;
    if (!marks[i * size + (size - 1 - i)]) d2 = false;
  }
  return d1 && d2;
}

function checkPattern(marks, size, patternId) {
  const p = PATTERNS[patternId];
  return p ? p.check(marks, size) : false;
}

// GAME STATE
// code -> {
//   songs: [{title, artist, url, duration, startMs, order}],
//   revealed: string[], // titles
//   currentSongIndex: number,
//   players: Map(socketId -> {name, cardTitles, marks, size, freeIndex, socketId}),
//   winner: string | null,
//   winners: string[], // all winners this round
//   pendingClaim: {socketId, name} | null,
//   status: 'lobby' | 'playing' | 'paused' | 'ended',
//   settings: { cardSize, pattern, snippetSeconds, gapSeconds, autoPlay, rounds },
//   round: number,
//   roundWinners: Map(round -> [names]),
//   createdAt, hostSocketId,
//   autoPlayTimer: timeout | null,
//   snippetTimer: timeout | null,
// }
const games = new Map();

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [code, game] of games) {
    if (game.createdAt < cutoff) {
      clearTimers(game);
      games.delete(code);
    }
  }
}, 60 * 60 * 1000);

function clearTimers(game) {
  if (game.autoPlayTimer) { clearTimeout(game.autoPlayTimer); game.autoPlayTimer = null; }
  if (game.snippetTimer) { clearTimeout(game.snippetTimer); game.snippetTimer = null; }
}

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
function gridSizeFor(n, preferred) {
  if (preferred && preferred >= 3 && preferred <= 7) {
    if (preferred * preferred <= n) return preferred;
  }
  if (n >= 49) return 7;
  if (n >= 36) return 6;
  if (n >= 25) return 5;
  if (n >= 16) return 4;
  if (n >= 9) return 3;
  return 0;
}
function playersPayload(game) {
  return {
    count: game.players.size,
    names: Array.from(game.players.values()).map(p => p.name)
  };
}

function newGame(songs, settings, hostSocketId) {
  const code = genCode();
  const size = gridSizeFor(songs.length, settings.cardSize);
  const processedSongs = songs.map((s, i) => ({
    title: s.title,
    artist: s.artist || '',
    url: s.url || null,
    duration: s.duration || 0,
    startMs: s.startMs || 0,
    order: i
  }));
  games.set(code, {
    code,
    songs: processedSongs,
    revealed: [],
    currentSongIndex: -1,
    players: new Map(),
    winner: null,
    winners: [],
    pendingClaim: null,
    status: 'lobby',
    settings: {
      cardSize: size,
      pattern: settings.pattern || '1line',
      snippetSeconds: settings.snippetSeconds || 30,
      gapSeconds: settings.gapSeconds || 5,
      autoPlay: settings.autoPlay !== false,
      rounds: settings.rounds || 1,
      ...settings
    },
    round: 1,
    roundWinners: new Map(),
    createdAt: Date.now(),
    hostSocketId,
    autoPlayTimer: null,
    snippetTimer: null,
    history: []
  });
  return code;
}

function getCurrentSong(game) {
  if (game.currentSongIndex < 0 || game.currentSongIndex >= game.songs.length) return null;
  return game.songs[game.currentSongIndex];
}

function advanceToNextSong(game, io) {
  const remaining = game.songs.filter(s => !game.revealed.includes(s.title));
  if (remaining.length === 0) {
    // Round ended, all songs played
    endRound(game, io);
    return;
  }
  const pick = remaining[Math.floor(Math.random() * remaining.length)];
  game.revealed.push(pick.title);
  game.currentSongIndex = game.songs.findIndex(s => s.title === pick.title);
  game.history.push({ title: pick.title, artist: pick.artist, playedAt: Date.now() });

  io.to(game.code).emit('game_update', {
    revealed: game.revealed,
    currentSong: pick,
    currentSongIndex: game.currentSongIndex,
    status: game.status,
    round: game.round,
    totalSongs: game.songs.length
  });

  // Auto-advance after snippet
  if (game.settings.autoPlay) {
    const snippetMs = (game.settings.snippetSeconds || 30) * 1000;
    game.snippetTimer = setTimeout(() => {
      if (game.status !== 'playing') return;
      io.to(game.code).emit('song_ended', { title: pick.title });
      // Gap before next
      const gapMs = (game.settings.gapSeconds || 5) * 1000;
      game.autoPlayTimer = setTimeout(() => {
        if (game.status === 'playing') advanceToNextSong(game, io);
      }, gapMs);
    }, snippetMs);
  }
}

function endRound(game, io) {
  game.status = 'ended';
  clearTimers(game);
  io.to(game.code).emit('round_ended', {
    round: game.round,
    winners: game.roundWinners.get(game.round) || [],
    revealed: game.revealed
  });
}

function startNextRound(game, io) {
  if (game.round >= game.settings.rounds) {
    io.to(game.code).emit('game_ended', {
      allWinners: Array.from(game.roundWinners.entries()).map(([r, w]) => ({ round: r, winners: w }))
    });
    return;
  }
  game.round++;
  game.revealed = [];
  game.currentSongIndex = -1;
  game.winner = null;
  game.winners = [];
  game.pendingClaim = null;
  game.status = 'lobby';
  game.players.forEach(p => {
    p.marks = new Array(p.marks.length).fill(false);
    if (p.freeIndex >= 0) p.marks[p.freeIndex] = true;
    // New card for new round
    const total = p.size * p.size;
    p.cardTitles = shuffle(game.songs.map(s => s.title)).slice(0, total);
  });
  clearTimers(game);
  io.to(game.code).emit('new_round', {
    round: game.round,
    totalRounds: game.settings.rounds,
    status: 'lobby',
    revealed: [],
    currentSong: null
  });
}

// ============================================================
// SOCKET.IO
// ============================================================

io.on('connection', (socket) => {

  // ---- CREATE GAME ----
  socket.on('create_game', (data, cb) => {
    const { songs, settings } = data || {};
    if (!Array.isArray(songs) || songs.length < 9) {
      return cb({ error: 'Нужно минимум 9 песен.' });
    }
    const code = newGame(songs, settings || {}, socket.id);
    socket.join(code);
    const game = games.get(code);
    cb({
      code,
      songs: game.songs,
      settings: game.settings,
      status: game.status,
      round: game.round
    });
  });

  socket.on('create_game_from_folder', (data, cb) => {
    const { slug, count, settings } = data || {};
    const lib = loadLibrary();
    const folder = lib[slug];
    if (!folder) return cb({ error: 'Папка не найдена.' });
    if (folder.songs.length < 9) return cb({ error: 'В папке меньше 9 песен.' });
    const n = Math.max(9, Math.min(count || folder.songs.length, folder.songs.length));
    const chosen = shuffle(folder.songs).slice(0, n);
    const code = newGame(chosen, settings || {}, socket.id);
    socket.join(code);
    const game = games.get(code);
    cb({
      code,
      songs: game.songs,
      settings: game.settings,
      status: game.status,
      round: game.round
    });
  });

  // ---- HOST REJOIN ----
  socket.on('host_rejoin', (code, cb) => {
    const game = games.get(code);
    if (!game) return cb({ error: 'Игра не найдена (возможно, истекла).' });
    socket.join(code);
    game.hostSocketId = socket.id;
    cb({
      code: game.code,
      songs: game.songs,
      revealed: game.revealed,
      currentSong: getCurrentSong(game),
      currentSongIndex: game.currentSongIndex,
      winner: game.winner,
      winners: game.winners,
      playerCount: game.players.size,
      pendingClaim: game.pendingClaim ? { name: game.pendingClaim.name } : null,
      status: game.status,
      settings: game.settings,
      round: game.round,
      roundWinners: Array.from(game.roundWinners.entries()).map(([r, w]) => ({ round: r, winners: w })),
      history: game.history
    });
  });

  // ---- START GAME ----
  socket.on('start_game', (code, cb) => {
    const game = games.get(code);
    if (!game) return cb && cb({ error: 'Игра не найдена.' });
    if (game.status !== 'lobby') return cb && cb({ error: 'Игра уже начата.' });
    game.status = 'playing';
    io.to(code).emit('game_started', {
      status: 'playing',
      round: game.round,
      totalRounds: game.settings.rounds,
      pattern: game.settings.pattern,
      patternName: PATTERNS[game.settings.pattern]?.name || '1 Line'
    });
    // Countdown 3-2-1
    let count = 3;
    const doCount = () => {
      if (count > 0) {
        io.to(code).emit('countdown', { count });
        count--;
        setTimeout(doCount, 1000);
      } else {
        io.to(code).emit('countdown', { count: 0 });
        advanceToNextSong(game, io);
      }
    };
    doCount();
    cb && cb({ ok: true });
  });

  // ---- PAUSE / RESUME ----
  socket.on('pause_game', (code, cb) => {
    const game = games.get(code);
    if (!game || game.status !== 'playing') return cb && cb({ error: 'Нельзя поставить на паузу.' });
    game.status = 'paused';
    clearTimers(game);
    io.to(code).emit('game_paused', { status: 'paused' });
    cb && cb({ ok: true });
  });

  socket.on('resume_game', (code, cb) => {
    const game = games.get(code);
    if (!game || game.status !== 'paused') return cb && cb({ error: 'Нельзя возобновить.' });
    game.status = 'playing';
    io.to(code).emit('game_resumed', { status: 'playing' });
    // Resume from current song
    const current = getCurrentSong(game);
    if (current) {
      io.to(code).emit('game_update', {
        revealed: game.revealed,
        currentSong: current,
        currentSongIndex: game.currentSongIndex,
        status: game.status
      });
      // Restart snippet timer
      const snippetMs = (game.settings.snippetSeconds || 30) * 1000;
      game.snippetTimer = setTimeout(() => {
        if (game.status !== 'playing') return;
        io.to(code).emit('song_ended', { title: current.title });
        const gapMs = (game.settings.gapSeconds || 5) * 1000;
        game.autoPlayTimer = setTimeout(() => {
          if (game.status === 'playing') advanceToNextSong(game, io);
        }, gapMs);
      }, snippetMs);
    }
    cb && cb({ ok: true });
  });

  // ---- MANUAL NEXT ----
  socket.on('reveal_next', (code, cb) => {
    const game = games.get(code);
    if (!game) return cb && cb({ error: 'Игра не найдена.' });
    if (game.status !== 'playing') return cb && cb({ error: 'Игра не активна.' });
    clearTimers(game);
    advanceToNextSong(game, io);
    cb && cb({ ok: true, revealed: game.revealed, currentSong: getCurrentSong(game) });
  });

  // ---- SKIP SONG ----
  socket.on('skip_song', (code, cb) => {
    const game = games.get(code);
    if (!game) return cb && cb({ error: 'Игра не найдена.' });
    clearTimers(game);
    io.to(code).emit('song_skipped', { title: getCurrentSong(game)?.title });
    advanceToNextSong(game, io);
    cb && cb({ ok: true });
  });

  // ---- NEXT ROUND ----
  socket.on('next_round', (code, cb) => {
    const game = games.get(code);
    if (!game) return cb && cb({ error: 'Игра не найдена.' });
    startNextRound(game, io);
    cb && cb({ ok: true });
  });

  // ---- RESET ----
  socket.on('reset_game', (code, cb) => {
    const game = games.get(code);
    if (!game) return cb && cb({ error: 'Игра не найдена.' });
    game.revealed = [];
    game.currentSongIndex = -1;
    game.winner = null;
    game.winners = [];
    game.pendingClaim = null;
    game.status = 'lobby';
    game.round = 1;
    game.roundWinners = new Map();
    game.history = [];
    clearTimers(game);
    game.players.forEach(p => {
      p.marks = new Array(p.marks.length).fill(false);
      if (p.freeIndex >= 0) p.marks[p.freeIndex] = true;
      const total = p.size * p.size;
      p.cardTitles = shuffle(game.songs.map(s => s.title)).slice(0, total);
    });
    io.to(code).emit('game_reset', {
      revealed: [],
      currentSong: null,
      status: 'lobby',
      round: 1
    });
    cb && cb({ ok: true });
  });

  // ---- JOIN GAME (player/screen) ----
  socket.on('join_game', (data, cb) => {
    const { code, name } = data || {};
    const game = games.get(code);
    if (!game) return cb({ error: 'Игра с таким кодом не найдена.' });
    const size = game.settings.cardSize;
    if (size === 0) return cb({ error: 'В этой игре пока маловато песен для карточки.' });
    socket.join(code);

    const total = size * size;
    const freeIndex = size % 2 === 1 ? Math.floor(total / 2) : -1;
    let player = game.players.get(socket.id);
    if (!player) {
      const cardTitles = shuffle(game.songs.map(s => s.title)).slice(0, total);
      const marks = new Array(total).fill(false);
      if (freeIndex >= 0) marks[freeIndex] = true;
      player = {
        name: (name || 'Игрок').slice(0, 30),
        cardTitles, marks, size, freeIndex,
        socketId: socket.id,
        joinedAt: Date.now()
      };
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
      currentSong: getCurrentSong(game),
      currentSongIndex: game.currentSongIndex,
      winner: game.winner,
      winners: game.winners,
      status: game.status,
      round: game.round,
      totalRounds: game.settings.rounds,
      totalSongs: game.songs.length,
      pattern: game.settings.pattern,
      patternName: PATTERNS[game.settings.pattern]?.name || '1 Line'
    });
  });

  // ---- TOGGLE MARK ----
  socket.on('toggle_mark', (data) => {
    const { code, index } = data || {};
    const game = games.get(code);
    if (!game || game.winner || game.status !== 'playing') return;
    const player = game.players.get(socket.id);
    if (!player) return;
    if (index === player.freeIndex || index < 0 || index >= player.cardTitles.length) return;
    const title = player.cardTitles[index];
    if (!game.revealed.includes(title)) return;
    player.marks[index] = !player.marks[index];
    socket.emit('mark_update', { marks: player.marks });
  });

  // ---- CLAIM BINGO ----
  socket.on('claim_bingo', (code, cb) => {
    const game = games.get(code);
    if (!game || game.winner || game.pendingClaim || game.status !== 'playing') return;
    const player = game.players.get(socket.id);
    if (!player) return;
    // Check if pattern is actually matched
    const patternMatched = checkPattern(player.marks, player.size, game.settings.pattern);
    if (!patternMatched) {
      socket.emit('bingo_rejected', { reason: 'pattern_not_matched' });
      return cb && cb({ error: 'Паттерн не собран.' });
    }
    game.pendingClaim = { socketId: socket.id, name: player.name };
    io.to(code).emit('bingo_claim', { name: player.name, socketId: socket.id });
    cb && cb({ ok: true });
  });

  // ---- VERIFY BINGO ----
  socket.on('verify_bingo', (code, cb) => {
    const game = games.get(code);
    if (!game || !game.pendingClaim) return cb && cb({ error: 'Нет активной заявки.' });
    const claim = game.pendingClaim;
    const player = game.players.get(claim.socketId);
    const valid = player ? checkPattern(player.marks, player.size, game.settings.pattern) : false;
    game.pendingClaim = null;
    if (valid) {
      game.winner = claim.name;
      game.winners.push(claim.name);
      const roundWins = game.roundWinners.get(game.round) || [];
      roundWins.push(claim.name);
      game.roundWinners.set(game.round, roundWins);
      io.to(code).emit('winner_update', {
        winner: game.winner,
        winners: game.winners,
        round: game.round,
        roundWinners: Array.from(game.roundWinners.entries()).map(([r, w]) => ({ round: r, winners: w }))
      });
      // Pause game on winner
      game.status = 'paused';
      clearTimers(game);
      io.to(code).emit('game_paused', { status: 'paused', reason: 'winner', winner: game.winner });
    } else {
      io.to(code).emit('bingo_claim_cleared', {});
      io.to(claim.socketId).emit('bingo_rejected', { reason: 'invalid' });
    }
    cb && cb({ ok: true, valid });
  });

  // ---- REJECT BINGO ----
  socket.on('reject_bingo', (code, cb) => {
    const game = games.get(code);
    if (!game || !game.pendingClaim) return cb && cb({ error: 'Нет активной заявки.' });
    const claim = game.pendingClaim;
    game.pendingClaim = null;
    io.to(code).emit('bingo_claim_cleared', {});
    io.to(claim.socketId).emit('bingo_rejected', { reason: 'rejected_by_host' });
    cb && cb({ ok: true });
  });

  // ---- GET LEADERBOARD ----
  socket.on('get_leaderboard', (code, cb) => {
    const game = games.get(code);
    if (!game) return cb && cb({ error: 'Игра не найдена.' });
    const board = Array.from(game.players.values()).map(p => ({
      name: p.name,
      marksCount: p.marks.filter(Boolean).length,
      totalCells: p.marks.length,
      percent: Math.round((p.marks.filter(Boolean).length / p.marks.length) * 100)
    })).sort((a, b) => b.marksCount - a.marksCount);
    cb && cb({ leaderboard: board });
  });

  // ---- DISCONNECT ----
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
