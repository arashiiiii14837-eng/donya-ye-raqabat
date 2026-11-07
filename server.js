const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Leaderboard is kept in memory; it resets when the server restarts.
const leaderboard = new Map();
app.post('/api/leaderboard', (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/[\u0000-\u001f]/g, '').slice(0, 24);
  if (!name) return res.status(400).json({ error: 'name_required' });
  const rawCoins = Number(req.body?.coins);
  const rawLevel = Number(req.body?.level);
  if (!Number.isFinite(rawCoins) || !Number.isFinite(rawLevel))
    return res.status(400).json({ error: 'invalid_score' });
  const coins = Math.max(0, Math.min(100000000, Math.floor(rawCoins)));
  const level = Math.max(0, Math.min(100000, Math.floor(rawLevel)));
  const old = leaderboard.get(name) || { name, coins: 0, level: 0 };
  old.coins = coins;
  old.level = level;
  leaderboard.set(name, old);
  res.json({ ok: true });
});
app.get('/api/leaderboard', (req, res) => {
  const field = req.query.type === 'level' ? 'level' : 'coins';
  const players = [...leaderboard.values()]
    .sort((a, b) => b[field] - a[field] || a.name.localeCompare(b.name, 'fa'))
    .slice(0, 10).map(p => ({ name: p.name, value: p[field] }));
  res.json({ type: field, players });
});

let nextRoomId = 1;
let nextRoamId = 1;
const waiting = new Map();
const rooms = new Map();
const friendlyRooms = new Map();
const roamWorlds = new Map();
const GAME_KINDS = ['word', 'tic', 'math', 'speed', 'mines', 'dice', 'fleet'];

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch (err) { console.error('WebSocket send failed:', err.message); }
  }
}
function broadcast(room, data) { room.players.forEach(p => send(p, data)); }
function removeFromQueues(ws) {
  for (const [kind, value] of waiting.entries()) {
    if (Array.isArray(value)) {
      const next = value.filter(p => p !== ws && p.readyState === WebSocket.OPEN);
      if (next.length) waiting.set(kind, next); else waiting.delete(kind);
    } else if (value === ws || !value || value.readyState !== WebSocket.OPEN) waiting.delete(kind);
  }
}
function normalizeAnswer(value) {
  return String(value ?? '').trim().toLowerCase()
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/\s+/g, ' ');
}
function otherPlayer(room, ws) { return room.players.find(p => p !== ws); }
function scoresFor(room, ws) {
  const i = room.players.indexOf(ws);
  return { you: room.scores[i] || 0, opponent: room.scores.filter((_, j) => j !== i).reduce((a,b)=>a+b,0) };
}
function sendScores(room) {
  room.players.forEach((p, i) => send(p, {
    type: 'score', you: room.scores[i] || 0,
    opponent: room.scores.reduce((sum, n, j) => sum + (j === i ? 0 : n), 0)
  }));
}

// Social roaming worlds: park and shrine.
function roamSnapshot(world) {
  const players = {};
  for (const [id, player] of world.players) players[id] = { ...player };
  return players;
}
function roamBroadcast(world, payload, except = null) {
  for (const client of world.clients) if (client !== except) send(client, payload);
}
function roamJoin(ws, data) {
  if (ws.roamWorld) roamLeave(ws);
  const map = data.map === 'shrine' ? 'shrine' : 'park';
  const id = String(nextRoamId++);
  let world = roamWorlds.get(map);
  if (!world) { world = { map, clients: new Set(), players: new Map() }; roamWorlds.set(map, world); }
  const player = {
    name: String(data.name || 'بازیکن').trim().slice(0, 24) || 'بازیکن',
    x: Math.max(4, Math.min(96, Number.isFinite(Number(data.x)) ? Number(data.x) : 50)),
    y: Math.max(8, Math.min(92, Number.isFinite(Number(data.y)) ? Number(data.y) : 70)),
    sitting: false, walking: false, bubble: ''
  };
  world.clients.add(ws); world.players.set(id, player);
  ws.roamWorld = world; ws.roamId = id;
  send(ws, { type: 'roam_state', id, players: roamSnapshot(world) });
  roamBroadcast(world, { type: 'roam_move', id, player }, ws);
}
function roamMove(ws, data) {
  const world = ws.roamWorld, id = ws.roamId;
  if (!world || !world.players.has(id)) return;
  const old = world.players.get(id);
  const player = { ...old,
    x: Math.max(4, Math.min(96, Number.isFinite(Number(data.x)) ? Number(data.x) : old.x)),
    y: Math.max(8, Math.min(92, Number.isFinite(Number(data.y)) ? Number(data.y) : old.y)),
    sitting: !!data.sitting, walking: !!data.walking
  };
  world.players.set(id, player);
  roamBroadcast(world, { type: 'roam_move', id, player }, ws);
}
function roamChat(ws, data) {
  const world = ws.roamWorld;
  if (!world || !world.players.has(ws.roamId)) return;
  const text = String(data.text || '').trim().slice(0, 100);
  if (!text) return;
  const player = world.players.get(ws.roamId);
  roamBroadcast(world, { type: 'roam_chat', id: ws.roamId, name: player.name, text });
}
function roamEmote(ws, data) {
  const world = ws.roamWorld, id = ws.roamId;
  if (!world || !world.players.has(id)) return;
  const allowed = ['سلام 👋', 'خوبی؟ 😊', 'آره 👍', 'بیا دنبالم 🚶'];
  const text = String(data.text || '');
  if (!allowed.includes(text)) return;
  const player = { ...world.players.get(id), bubble: text };
  world.players.set(id, player);
  roamBroadcast(world, { type: 'roam_emote', id, name: player.name, text, player });
  setTimeout(() => {
    if (!world.players.has(id)) return;
    const current = world.players.get(id);
    if (current.bubble === text) {
      const cleared = { ...current, bubble: '' };
      world.players.set(id, cleared);
      roamBroadcast(world, { type: 'roam_move', id, player: cleared });
    }
  }, 2800);
}
function roamLeave(ws) {
  const world = ws.roamWorld, id = ws.roamId;
  if (!world) return;
  world.clients.delete(ws); world.players.delete(id);
  ws.roamWorld = null; ws.roamId = null;
  roamBroadcast(world, { type: 'roam_leave', id });
  if (!world.clients.size) roamWorlds.delete(world.map);
}

// Private rooms.
function friendlyCode() {
  let code;
  do { code = Math.random().toString(36).slice(2, 8).toUpperCase(); }
  while (friendlyRooms.has(code));
  return code;
}
function friendlyPayload(room, type = 'friendly_update', message = '') {
  const payload = { type, code: room.code,
    players: room.players.map(p => ({ name: p.playerName || 'بازیکن' })),
    kind: room.kind || null, message };
  room.players.forEach(p => send(p, payload));
}
function createFriendly(ws, data) {
  if (ws.friendlyRoom || ws.room) return send(ws, { type: 'error', message: 'ابتدا از اتاق قبلی خارج شو.' });
  removeFromQueues(ws);
  ws.playerName = String(data.name || 'میزبان').trim().slice(0, 24) || 'میزبان';
  const code = friendlyCode();
  const room = { code, players: [ws], host: ws, kind: null, started: false };
  friendlyRooms.set(code, room); ws.friendlyRoom = room;
  send(ws, { type: 'friendly_created', code, players: [{ name: ws.playerName }], message: 'اتاق ساخته شد؛ کد را برای دوستت بفرست.' });
}
function joinFriendly(ws, data) {
  const code = String(data.code || '').trim().toUpperCase();
  const room = friendlyRooms.get(code);
  if (!room || room.started) return send(ws, { type: 'error', message: 'اتاقی با این کد پیدا نشد یا مسابقه شروع شده است.' });
  if (ws.friendlyRoom || ws.room) return send(ws, { type: 'error', message: 'ابتدا از اتاق قبلی خارج شو.' });
  if (room.players.length >= 3) return send(ws, { type: 'error', message: 'ظرفیت اتاق تکمیل شده است.' });
  removeFromQueues(ws);
  ws.playerName = String(data.name || 'بازیکن').trim().slice(0, 24) || 'بازیکن';
  room.players.push(ws); ws.friendlyRoom = room;
  friendlyPayload(room, 'friendly_joined', 'بازیکن جدید وارد اتاق شد.');
}
function leaveFriendly(ws) {
  const room = ws.friendlyRoom;
  if (!room) return;
  room.players = room.players.filter(p => p !== ws);
  ws.friendlyRoom = null;
  if (!room.players.length) { friendlyRooms.delete(room.code); return; }
  if (room.host === ws) room.host = room.players[0];
  friendlyPayload(room, 'friendly_update', 'یک بازیکن از اتاق خارج شد.');
}

const challenges = {
  word: [
    { q: 'کدام واژه با «آ» شروع می‌شود؟ (آب، میز، کتاب)', a: 'آب' },
    { q: 'مخالف واژهٔ «سرد» چیست؟', a: 'گرم' },
    { q: 'جمع «کتاب» چیست؟', a: 'کتاب ها' },
    { q: 'کدام یک میوه است؟ (سیب، صندلی، مداد)', a: 'سیب' },
    { q: 'مخالف «بلند» چیست؟', a: 'کوتاه' }
  ],
  math: [
    { q: '۷ + ۵ چند می‌شود؟', a: '12' }, { q: '۹ × ۳ چند می‌شود؟', a: '27' },
    { q: '۲۵ - ۸ چند می‌شود؟', a: '17' }, { q: '۴۸ ÷ ۶ چند می‌شود؟', a: '8' },
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

app.get('/', (_req, res) => res.send('Donya Ye Raqabat Server is Online!'));
app.get('/health', (_req, res) => res.json({ ok: true, waiting: waiting.size, rooms: rooms.size, friendlyRooms: friendlyRooms.size, roamWorlds: roamWorlds.size }));

function startCountdown(room) {
  let n = 3;
  const tick = () => {
    if (room.finished || !rooms.has(room.id)) return;
    broadcast(room, { type: 'countdown', value: n });
    if (n === 0) { startRound(room); return; }
    n--; setTimeout(tick, 1000);
  };
  tick();
}
function makeMines() {
  const result = [];
  while (result.length < 3) { const n = Math.floor(Math.random() * 25); if (!result.includes(n)) result.push(n); }
  return result;
}
function broadcastMines(room, extra = {}) {
  room.players.forEach(p => send(p, { type: 'mines_state', round: room.round, revealed: room.revealed, turn: room.symbols[room.turn], ...extra }));
}
function broadcastDice(room) {
  room.players.forEach(p => send(p, { type: 'dice_state', round: room.round, turn: room.symbols[room.turn], rolled: room.diceRolled.map((v,i)=>v?room.symbols[i]:null).filter(Boolean) }));
}
function broadcastTic(room) {
  room.players.forEach(p => send(p, { type: 'tic_state', board: room.board, turn: room.symbols[room.turn], round: room.round }));
}
function fleetStateFor(room, ws, message) {
  const i = room.players.indexOf(ws); if (i < 0) return;
  let targetIndex = room.target[i];
  for (let tries = 0; tries < 3 && room.eliminated[targetIndex]; tries++) targetIndex = (targetIndex + 1) % 3;
  room.target[i] = targetIndex;
  const board = room.phase === 'place' ? Array.from({length:36},(_,n)=>room.ships[i].includes(n)?'ship':'') : room.shots[i][targetIndex];
  const opponents = room.players.map((p,j)=>({name:p.playerName,remaining:room.ships[j].length,alive:!room.eliminated[j]})).filter((_,j)=>j!==i);
  send(ws, { type:'fleet_state', phase:room.phase, board, opponents, placed:room.ships[i].length,
    canShoot:room.phase==='battle' && room.turn===i && !room.eliminated[i],
    target:room.players[targetIndex]?.playerName||'', turn:room.players[room.turn]?.playerName||'', message });
}
function broadcastFleet(room, message) { room.players.forEach(p => fleetStateFor(room,p,message)); }
function advanceFleetTurn(room) {
  for (let step=1; step<=3; step++) { const n=(room.turn+step)%3; if(!room.eliminated[n]) { room.turn=n; return; } }
}
function fleetFinishIfNeeded(room) {
  const alive = room.eliminated.map((v,i)=>!v?i:-1).filter(i=>i>=0);
  if (alive.length > 1) return false;
  room.finished = true;
  room.players.forEach((p,i)=>send(p,{type:'game_over',result:alive[0]===i?'win':'lose',you:room.scores[i]||0,opponent:0,winner:alive.length?room.players[alive[0]].playerName:'بدون برنده'}));
  setTimeout(()=>{ room.players.forEach(p=>{if(p.room===room)p.room=null;}); rooms.delete(room.id); },30000);
  return true;
}
function handleFleet(room, ws, data) {
  const i=room.players.indexOf(ws); if(i<0||room.finished) return;
  if(room.phase==='place' && data.type==='fleet_place') {
    const n=Number(data.index);
    if(!Number.isInteger(n)||n<0||n>=36||room.ships[i].length>=3||room.ships[i].includes(n)) return;
    room.ships[i].push(n);
    if(room.ships.every(a=>a.length===3)) { room.phase='battle'; room.turn=0; broadcastFleet(room,'⚓ همه ناوگان‌ها آماده‌اند! نبرد شروع شد.'); }
    else broadcastFleet(room,`کشتی ${room.ships[i].length} از ۳ ثبت شد.`);
    return;
  }
  if(room.phase==='battle' && data.type==='fleet_shot') {
    if(room.turn!==i||room.eliminated[i]) return;
    const n=Number(data.index); if(!Number.isInteger(n)||n<0||n>=36) return;
    let target=room.target[i];
    for(let tries=0;tries<3&&room.eliminated[target];tries++) target=(target+1)%3;
    if(target===i||room.shots[i][target][n]) return;
    const hit=room.ships[target].includes(n); room.shots[i][target][n]=hit?'hit':'miss';
    // Count unique ship cells hit by all opponents. Multiple players may
    // shoot the same cell, but that cell must only count once.
    const hitCells = new Set();
    for (let shooter = 0; shooter < room.players.length; shooter++) {
      for (let cell = 0; cell < 36; cell++) {
        if (room.shots[shooter][target][cell] === 'hit') hitCells.add(cell);
      }
    }
    if (room.ships[target].every(cell => hitCells.has(cell))) {
      room.eliminated[target] = true;
    }
    room.players.forEach(p=>send(p,{type:'fleet_shot',shooter:ws.playerName,target:room.players[target].playerName,index:n,result:hit?'hit':'miss',message:hit?'💥 برخورد! یکی از کشتی‌های حریف پیدا شد.':'🌊 شلیک به آب خورد!'}));
    if(fleetFinishIfNeeded(room)) return;
    advanceFleetTurn(room); broadcastFleet(room,hit?'💥 برخورد موفق!':'🌊 این شلیک به آب خورد.');
  }
}
function startRound(room) {
  if(room.finished) return;
  if(room.kind==='fleet') {
    room.phase='place'; room.ships=[[],[],[]];
    room.shots=Array.from({length:3},()=>Array.from({length:3},()=>Array(36).fill('')));
    room.eliminated=[false,false,false]; room.target=[1,2,0]; room.turn=0;
    broadcastFleet(room,'سه خانه برای کشتی‌هایت انتخاب کن.'); return;
  }
  room.round++;
  if(room.round>5) return finishGame(room);
  room.answers=new Map(); room.roundResolved=false;
  if(room.kind==='tic') { room.board=Array(9).fill(''); room.turn=(room.round-1)%2; broadcastTic(room); }
  else if(room.kind==='dice') { room.turn=(room.round-1)%2; room.diceRolled=[false,false]; broadcastDice(room); }
  else if(room.kind==='mines') { room.mines=makeMines(); room.revealed=Array(25).fill(false); room.turn=(room.round-1)%2; broadcastMines(room); }
  else { room.prompt=challenges[room.kind][room.round-1]; broadcast(room,{type:'round_start',round:room.round,prompt:{q:room.prompt.q}}); }
}
function finishRound(room, winnerIndex) {
  if(room.roundResolved||room.finished) return;
  room.roundResolved=true;
  if(winnerIndex>=0&&winnerIndex<room.players.length) room.scores[winnerIndex]++;
  room.players.forEach((p,i)=>send(p,{type:'round_result',round:room.round,you:room.scores[i],opponent:room.scores.reduce((s,n,j)=>s+(j===i?0:n),0),message:winnerIndex===-1?'این دست مساوی شد!':winnerIndex===i?'این دست رو بردی! 🎉':'این دست رو حریف برد.'}));
  sendScores(room);
  setTimeout(()=>{if(room.finished)return;if(room.round>=5)finishGame(room);else startRound(room);},1600);
}
function finishGame(room) {
  if(room.finished)return; room.finished=true;
  room.players.forEach((p,i)=>{
    const opponent=room.scores.reduce((s,n,j)=>s+(j===i?0:n),0);
    send(p,{type:'game_over',result:room.scores[i]>opponent?'win':room.scores[i]<opponent?'lose':'draw',you:room.scores[i],opponent});
  });
  setTimeout(()=>{room.players.forEach(p=>{if(p.room===room)p.room=null;});rooms.delete(room.id);},30000);
}
function leaveRoom(ws) {
  const room=ws.room; if(!room)return;
  const others=room.players.filter(p=>p!==ws);
  others.forEach(p=>{send(p,{type:'opponent_left'});if(p.room===room)p.room=null;});
  if(ws.room===room)ws.room=null;
  room.finished=true; rooms.delete(room.id);
}
function makeTwoPlayerRoom(players,kind,friendly=false) {
  const id=nextRoomId++;
  const room={id,players,kind,round:0,scores:[0,0],symbols:['X','O'],board:Array(9).fill(''),turn:0,answers:new Map(),finished:false,roundResolved:false,mines:[],revealed:Array(25).fill(false),diceRolled:[false,false]};
  rooms.set(id,room);
  players.forEach((p,i)=>{
    p.room=room;
    const opponent=players[1-i].playerName;
    send(p,friendly ? {type:'friendly_started',room:id,kind,symbol:room.symbols[i],opponent,match:{type:'matched',room:id,kind,symbol:room.symbols[i],opponent}} : {type:'matched',room:id,kind,symbol:room.symbols[i],opponent});
  });
  startCountdown(room);
}
function makeFleetRoom(players,friendly=false) {
  const id=nextRoomId++;
  const room={id,players,kind:'fleet',round:1,scores:[0,0,0],symbols:['P0','P1','P2'],finished:false,roundResolved:false,phase:'place',ships:[[],[],[]],shots:Array.from({length:3},()=>Array.from({length:3},()=>Array(36).fill(''))),turn:0,eliminated:[false,false,false],target:[1,2,0]};
  rooms.set(id,room);
  players.forEach((p,i)=>{
    p.room=room;
    const opponent=players.filter((_,j)=>j!==i).map(x=>x.playerName).join(' و ');
    send(p,friendly ? {type:'friendly_started',room:id,kind:'fleet',symbol:room.symbols[i],opponent,players:players.map(x=>x.playerName),match:{type:'matched',room:id,kind:'fleet',symbol:room.symbols[i],opponent}} : {type:'matched',room:id,kind:'fleet',symbol:room.symbols[i],opponent,players:players.map(x=>x.playerName)});
  });
  startCountdown(room);
}
function joinQueue(ws,data) {
  if(ws.room||ws.friendlyRoom) return send(ws,{type:'error',message:'ابتدا از مسابقه یا اتاق قبلی خارج شو.'});
  const kind=GAME_KINDS.includes(data.kind)?data.kind:'tic';
  removeFromQueues(ws);
  ws.playerName=String(data.name||'بازیکن').trim().slice(0,24)||'بازیکن'; ws.kind=kind;
  if(kind==='fleet') {
    let queue=waiting.get(kind)||[];
    queue=queue.filter(p=>p!==ws&&p.readyState===WebSocket.OPEN&&!p.room&&!p.friendlyRoom);
    queue.push(ws);
    if(queue.length<3){waiting.set(kind,queue);send(ws,{type:'waiting',needed:3,waiting:queue.length});return;}
    waiting.delete(kind); makeFleetRoom(queue.slice(0,3)); return;
  }
  const opponent=waiting.get(kind);
  if(!opponent||opponent===ws||opponent.readyState!==WebSocket.OPEN||opponent.room||opponent.friendlyRoom) {
    waiting.set(kind,ws);send(ws,{type:'waiting',needed:2,waiting:1});return;
  }
  waiting.delete(kind); makeTwoPlayerRoom([opponent,ws],kind);
}
function startFriendly(ws) {
  const room=ws.friendlyRoom;
  if(!room||room.host!==ws||room.started)return;
  const kind=GAME_KINDS.includes(room.kind)?room.kind:null;
  if(!kind)return send(ws,{type:'error',message:'اول یک بازی انتخاب کن.'});
  const needed=kind==='fleet'?3:2;
  if(room.players.length!==needed)return send(ws,{type:'error',message:`برای این بازی دقیقاً ${needed} بازیکن لازم است.`});
  if(room.players.some(p=>p.readyState!==WebSocket.OPEN))return send(ws,{type:'error',message:'اتصال یکی از بازیکنان قطع شده است.'});
  room.started=true;friendlyRooms.delete(room.code);
  const players=room.players.slice(); players.forEach(p=>{p.friendlyRoom=null;});
  if(kind==='fleet') makeFleetRoom(players,true); else makeTwoPlayerRoom(players,kind,true);
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let data;
    try { data=JSON.parse(raw.toString()); } catch { return send(ws,{type:'error',message:'پیام نامعتبر است.'}); }
    if(!data||typeof data!=='object')return;
    if(data.type==='roam_join')return roamJoin(ws,data);
    if(data.type==='roam_move')return roamMove(ws,data);
    if(data.type==='roam_emote')return roamEmote(ws,data);
    if(data.type==='roam_chat')return roamChat(ws,data);
    if(data.type==='roam_leave'){roamLeave(ws);return;}
    if(data.type==='find')return joinQueue(ws,data);
    if(data.type==='friendly_create')return createFriendly(ws,data);
    if(data.type==='friendly_join')return joinFriendly(ws,data);
    if(data.type==='friendly_select_game') {
      const fr=ws.friendlyRoom;
      if(!fr||fr.host!==ws)return send(ws,{type:'error',message:'فقط میزبان می‌تواند بازی را انتخاب کند.'});
      fr.kind=GAME_KINDS.includes(data.kind)?data.kind:null;
      return friendlyPayload(fr,'friendly_update','بازی انتخاب شد.');
    }
    if(data.type==='friendly_start')return startFriendly(ws);
    if(data.type==='friendly_leave'){leaveFriendly(ws);return;}
    if(data.type==='cancel_find'){removeFromQueues(ws);send(ws,{type:'search_cancelled'});return;}
    const room=ws.room;
    if(data.type==='leave')return leaveRoom(ws);
    if(!room||room.finished)return send(ws,{type:'error',message:'اتاق مسابقه پیدا نشد؛ دوباره جست‌وجو کن.'});
    if(room.kind==='fleet')return handleFleet(room,ws,data);
    if(room.roundResolved)return;
    if(room.kind==='dice'&&data.type==='dice_roll') {
      const i=room.players.indexOf(ws);if(i!==room.turn||room.diceRolled[i])return;
      room.diceRolled[i]=true;const die1=1+Math.floor(Math.random()*6),die2=1+Math.floor(Math.random()*6),won=die1===6&&die2===6;
      room.players.forEach(p=>send(p,{type:'dice_result',round:room.round,player:room.symbols[i],die1,die2,won,message:won?'🎉 جفت شیش! این دست را بردی!':`تاس‌ها ${die1} و ${die2} آمدند.`}));
      if(won)return finishRound(room,i);if(room.diceRolled.every(Boolean))return finishRound(room,-1);
      room.turn=1-room.turn;return broadcastDice(room);
    }
    if(room.kind==='mines'&&data.type==='mine_move') {
      const index=Number(data.index),i=room.players.indexOf(ws);
      if(i!==room.turn||!Number.isInteger(index)||index<0||index>24||room.revealed[index])return;
      room.revealed[index]=true;
      if(room.mines.includes(index)){broadcastMines(room,{mines:room.mines});return finishRound(room,1-i);}
      if(room.revealed.every(Boolean)){broadcastMines(room,{mines:room.mines});return finishRound(room,-1);}
      room.turn=1-room.turn;return broadcastMines(room);
    }
    if(room.kind==='tic'&&data.type==='tic_move') {
      const index=Number(data.index),i=room.players.indexOf(ws);
      if(i!==room.turn||!Number.isInteger(index)||index<0||index>8||room.board[index])return;
      room.board[index]=room.symbols[i];
      const wins=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
      const won=wins.some(line=>line.every(n=>room.board[n]===room.symbols[i]));
      if(won){broadcastTic(room);return finishRound(room,i);}
      if(room.board.every(Boolean)){broadcastTic(room);return finishRound(room,-1);}
      room.turn=1-room.turn;return broadcastTic(room);
    }
    if(['word','math','speed'].includes(room.kind)&&data.type==='answer') {
      if(Number(data.round)!==room.round||room.answers.has(ws))return;
      const expected=normalizeAnswer(room.prompt.a),actual=normalizeAnswer(data.answer);
      if(actual!==expected)return send(ws,{type:'answer_wrong',message:'جواب درست نیست؛ دوباره تلاش کن.'});
      room.answers.set(ws,true);return finishRound(room,room.players.indexOf(ws));
    }
  });
  ws.on('close',()=>{removeFromQueues(ws);leaveRoom(ws);leaveFriendly(ws);roamLeave(ws);});
  ws.on('error',()=>{removeFromQueues(ws);leaveRoom(ws);leaveFriendly(ws);roamLeave(ws);});
});

// Detect dead connections so disconnected players do not remain in queues or rooms.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      removeFromQueues(ws); leaveRoom(ws); leaveFriendly(ws); roamLeave(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { ws.terminate(); }
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Game server is running!'));

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
