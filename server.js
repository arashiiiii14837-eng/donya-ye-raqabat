const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// لیدربرد مشترک
const leaderboard = new Map();

app.post('/api/leaderboard', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 24);

  if (!name) {
    return res.status(400).json({ error: 'name_required' });
  }

  const coins = Math.max(
    0,
    Math.min(100000000, Math.floor(Number(req.body.coins) || 0))
  );

  const level = Math.max(
    0,
    Math.min(100000, Math.floor(Number(req.body.level) || 0))
  );

  const old = leaderboard.get(name) || {
    name,
    coins: 0,
    level: 0
  };

  old.coins = coins;
  old.level = level;

  leaderboard.set(name, old);

  res.json({ ok: true });
});

app.get('/api/leaderboard', (req, res) => {
  const field = req.query.type === 'level' ? 'level' : 'coins';

  const players = [...leaderboard.values()]
    .sort((a, b) => b[field] - a[field] || a.name.localeCompare(b.name))
    .slice(0, 10)
    .map(player => ({
      name: player.name,
      value: player[field]
    }));

  res.json({
    type: field,
    players
  });
});

// سیستم اتاق‌ها
let nextRoomId = 1;

const waiting = new Map();
const rooms = new Map();

// سؤال‌های مسابقه
const challenges = {
  word: [
    { q: 'کدام واژه با «آ» شروع می‌شود؟ (آب، میز، کتاب)', a: 'آب' },
    { q: 'مخالف واژهٔ «سرد» چیست؟', a: 'گرم' },
    { q: 'جمع «کتاب» چیست؟', a: 'کتاب ها' },
    { q: 'کدام یک میوه است؟ (سیب، صندلی، مداد)', a: 'سیب' },
    { q: 'مخالف «بلند» چیست؟', a: 'کوتاه' }
  ],

  math: [
    { q: '۷ + ۵ چند می‌شود؟', a: '12' },
    { q: '۹ × ۳ چند می‌شود؟', a: '27' },
    { q: '۲۵ - ۸ چند می‌شود؟', a: '17' },
    { q: '۴۸ ÷ ۶ چند می‌شود؟', a: '8' },
    { q: '۱۰ + ۱۵ چند می‌شود؟', a: '25' }
  ],

  speed: [
    { q: 'وقتی علامت شروع را دیدی، سریع دکمه را بزن!', a: 'go' },
    { q: 'آماده‌ای؟ سریع دکمه را بزن!', a: 'go' },
    { q: 'مرحله سوم؛ هرچه سریع‌تر!', a: 'go' },
    { q: 'مرحله چهارم؛ شروع!', a: 'go' },
    { q: 'مرحله آخر؛ سریع باش!', a: 'go' }
  ]
};

// صفحه اصلی سرور
app.get('/', (_req, res) => {
  res.send('Donya Ye Raqabat Server is Online!');
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    waiting: waiting.size,
    rooms: rooms.size
  });
});

// ارسال پیام
function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  room.players.forEach(p => send(p, data));
}

function otherPlayer(room, ws) {
  return room.players.find(p => p !== ws);
}

function scoresFor(room, ws) {
  const i = room.players.indexOf(ws);

  return {
    you: room.scores[i],
    opponent: room.scores[1 - i]
  };
}

function sendScores(room) {
  room.players.forEach(p => {
    send(p, {
      type: 'score',
      ...scoresFor(room, p)
    });
  });
}

function normalizeAnswer(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/\s+/g, ' ');
}

// ساخت مین‌ها
function makeMines() {
  const mines = [];

  while (mines.length < 3) {
    const n = Math.floor(Math.random() * 25);

    if (!mines.includes(n)) {
      mines.push(n);
    }
  }

  return mines;
}

// ارسال وضعیت مین‌یاب
function broadcastMines(room, extra = {}) {
  room.players.forEach(p => {
    send(p, {
      type: 'mines_state',
      round: room.round,
      revealed: room.revealed,
      turn: room.symbols[room.turn],
      ...extra
    });
  });
}

// شمارش معکوس
function startCountdown(room) {
  let n = 3;

  const tick = () => {
    if (room.finished) return;

    broadcast(room, {
      type: 'countdown',
      value: n
    });

    if (n === 0) {
      startRound(room);
      return;
    }

    n--;

    setTimeout(tick, 1000);
  };

  tick();
}

// شروع مرحله
function startRound(room) {
  if (room.finished) return;

  room.round++;

  if (room.round > 5) {
    return finishGame(room);
  }

  room.answers = new Map();
  room.roundResolved = false;

  if (room.kind === 'tic') {
    room.board = Array(9).fill('');
    room.turn = (room.round - 1) % 2;

    broadcastTic(room);
  }

  else if (room.kind === 'mines') {
    room.mines = makeMines();
    room.revealed = Array(25).fill(false);
    room.turn = (room.round - 1) % 2;

    broadcastMines(room);
  }

  else {
    room.prompt = challenges[room.kind][room.round - 1];

    broadcast(room, {
      type: 'round_start',
      round: room.round,
      prompt: {
        q: room.prompt.q
      }
    });
  }
}

// وضعیت دوز
function broadcastTic(room) {
  room.players.forEach(p => {
    send(p, {
      type: 'tic_state',
      board: room.board,
      turn: room.symbols[room.turn],
      round: room.round
    });
  });
}

// پایان دست
function finishRound(room, winnerIndex) {
  if (room.roundResolved || room.finished) return;

  room.roundResolved = true;

  if (winnerIndex === 0 || winnerIndex === 1) {
    room.scores[winnerIndex]++;
  }

  room.players.forEach((p, i) => {
    send(p, {
      type: 'round_result',
      round: room.round,
      you: room.scores[i],
      opponent: room.scores[1 - i],

      message:
        winnerIndex === -1
          ? 'این دست مساوی شد!'
          : winnerIndex === i
          ? 'این دست رو بردی! 🎉'
          : 'این دست رو حریف برد.'
    });
  });

  sendScores(room);

  setTimeout(() => {
    if (room.round >= 5) {
      finishGame(room);
    } else {
      startRound(room);
    }
  }, 1600);
}

// پایان مسابقه
function finishGame(room) {
  if (room.finished) return;

  room.finished = true;

  room.players.forEach((p, i) => {
    const result =
      room.scores[i] > room.scores[1 - i]
        ? 'win'
        : room.scores[i] < room.scores[1 - i]
        ? 'lose'
        : 'draw';

    send(p, {
      type: 'game_over',
      result,
      ...scoresFor(room, p)
    });
  });

  setTimeout(() => {
    room.players.forEach(p => {
      p.room = null;
    });

    rooms.delete(room.id);
  }, 30000);
}

// خروج بازیکن
function leaveRoom(ws) {
  const room = ws.room;

  if (!room) return;

  const opponent = otherPlayer(room, ws);

  send(opponent, {
    type: 'opponent_left'
  });

  room.finished = true;

  room.players.forEach(p => {
    p.room = null;
  });

  rooms.delete(room.id);
}

// جست‌وجوی حریف
function joinQueue(ws, data) {
  const allowed = [
    'tic',
    'word',
    'math',
    'speed',
    'mines'
  ];

  const kind = allowed.includes(data.kind)
    ? data.kind
    : 'tic';

  ws.playerName = String(data.name || 'بازیکن').slice(0, 24);
  ws.kind = kind;

  const opponent = waiting.get(kind);

  if (!opponent || opponent.readyState !== WebSocket.OPEN) {
    waiting.set(kind, ws);

    send(ws, {
      type: 'waiting'
    });

    return;
  }

  waiting.delete(kind);

  const id = nextRoomId++;

  const players = [opponent, ws];

  const room = {
    id,
    players,
    kind,
    round: 0,
    scores: [0, 0],
    symbols: ['X', 'O'],
    board: Array(9).fill(''),
    turn: 0,
    answers: new Map(),
    finished: false,
    roundResolved: false,
    mines: [],
    revealed: Array(25).fill(false)
  };

  rooms.set(id, room);

  players.forEach((p, i) => {
    p.room = room;

    send(p, {
      type: 'matched',
      room: id,
      symbol: room.symbols[i],
      opponent: players[1 - i].playerName
    });
  });

  startCountdown(room);
}

// اتصال بازیکنان
wss.on('connection', ws => {

  ws.on('message', raw => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return send(ws, {
        type: 'error',
        message: 'پیام نامعتبر است.'
      });
    }

    if (data.type === 'find') {
      return joinQueue(ws, data);
    }

    const room = ws.room;

    if (!room || room.finished) {
      return send(ws, {
        type: 'error',
        message: 'اتاق مسابقه پیدا نشد؛ دوباره جست‌وجو کن.'
      });
    }

    if (data.type === 'leave') {
      return leaveRoom(ws);
    }

    if (room.roundResolved) return;

    // حرکت در مین‌یاب
    if (room.kind === 'mines' && data.type === 'mine_move') {
      const index = Number(data.index);
      const playerIndex = room.players.indexOf(ws);

      if (
        playerIndex !== room.turn ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > 24 ||
        room.revealed[index]
      ) {
        return;
      }

      room.revealed[index] = true;

      if (room.mines.includes(index)) {
        broadcastMines(room, {
          mines: room.mines
        });

        return finishRound(room, 1 - playerIndex);
      }

      if (room.revealed.every(Boolean)) {
        broadcastMines(room, {
          mines: room.mines
        });

        return finishRound(room, -1);
      }

      room.turn = 1 - room.turn;

      return broadcastMines(room);
    }

    // حرکت در دوز
    if (room.kind === 'tic' && data.type === 'tic_move') {
      const index = Number(data.index);
      const playerIndex = room.players.indexOf(ws);

      if (
        playerIndex !== room.turn ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > 8 ||
        room.board[index]
      ) {
        return;
      }

      room.board[index] = room.symbols[playerIndex];

      const b = room.board;

      const wins = [
        [0, 1, 2],
        [3, 4, 5],
        [6, 7, 8],
        [0, 3, 6],
        [1, 4, 7],
        [2, 5, 8],
        [0, 4, 8],
        [2, 4, 6]
      ];

      const won = wins.some(line =>
        line.every(i => b[i] === room.symbols[playerIndex])
      );

      if (won) {
        broadcastTic(room);
        return finishRound(room, playerIndex);
      }

      if (b.every(Boolean)) {
        broadcastTic(room);
        return finishRound(room, -1);
      }

      room.turn = 1 - room.turn;

      return broadcastTic(room);
    }

    // جواب بازی‌های سؤال‌محور
    if (
      room.kind !== 'tic' &&
      room.kind !== 'mines' &&
      data.type === 'answer'
    ) {
      if (
        Number(data.round) !== room.round ||
        room.answers.has(ws)
      ) {
        return;
      }

      const expected = normalizeAnswer(room.prompt.a);
      const actual = normalizeAnswer(data.answer);

      if (actual !== expected) {
        return send(ws, {
          type: 'answer_wrong',
          message: 'جواب درست نیست؛ دوباره تلاش کن.'
        });
      }

      room.answers.set(ws, true);

      return finishRound(
        room,
        room.players.indexOf(ws)
      );
    }
  });

  ws.on('close', () => {
    for (const [kind, player] of waiting.entries()) {
      if (player === ws) {
        waiting.delete(kind);
      }
    }

    leaveRoom(ws);
  });
});

// اجرای سرور
server.listen(
  process.env.PORT || 3000,
  '0.0.0.0',
  () => console.log('Game server is running!')
);
