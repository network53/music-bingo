const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const safe = Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(file.originalname);
      cb(null, safe);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB per file
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Upload one or more mp3 files, returns [{title, url}]
app.post('/api/upload', upload.array('songs', 100), (req, res) => {
  const files = (req.files || []).map((f) => ({
    title: path.parse(f.originalname).name.replace(/[_\-]+/g, ' ').trim(),
    url: '/uploads/' + f.filename
  }));
  res.json({ files });
});

// In-memory store: code -> { songs: [{title, url}], revealed: string[], players: Map(socketId->name), winner, createdAt }
const games = new Map();

// Clean up games older than 12 hours, checked every hour
setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [code, game] of games) {
    if (game.createdAt < cutoff) games.delete(code);
  }
}, 60 * 60 * 1000);

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no O/0/I/1
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return games.has(c) ? genCode() : c;
}

function playersPayload(game) {
  return { count: game.players.size, names: Array.from(game.players.values()) };
}

io.on('connection', (socket) => {
  socket.on('create_game', (songs, cb) => {
    // songs: [{title, url}] — url may be null/undefined for text-only songs
    if (!Array.isArray(songs) || songs.length < 9) {
      return cb({ error: 'Нужно минимум 9 песен.' });
    }
    const code = genCode();
    games.set(code, {
      songs,
      revealed: [],
      players: new Map(),
      winner: null,
      createdAt: Date.now()
    });
    socket.join(code);
    cb({ code, songs });
  });

  socket.on('join_game', (code, name, cb) => {
    const game = games.get(code);
    if (!game) return cb({ error: 'Игра с таким кодом не найдена.' });
    socket.join(code);
    game.players.set(socket.id, (name || 'Игрок').slice(0, 30));
    io.to(code).emit('players_update', playersPayload(game));
    cb({
      songs: game.songs.map((s) => s.title),
      revealed: game.revealed,
      winner: game.winner
    });
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
    io.to(code).emit('game_update', { revealed: [], currentSong: null });
    io.to(code).emit('winner_update', { winner: null });
    cb && cb({ ok: true });
  });

  socket.on('claim_bingo', (code, name) => {
    const game = games.get(code);
    if (!game || game.winner) return; // first claim wins, ignore rest
    game.winner = name || 'Игрок';
    io.to(code).emit('winner_update', { winner: game.winner });
  });

  socket.on('disconnect', () => {
    for (const [code, game] of games.entries()) {
      if (game.players.delete(socket.id)) {
        io.to(code).emit('players_update', playersPayload(game));
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Music Bingo server listening on port ' + PORT));
