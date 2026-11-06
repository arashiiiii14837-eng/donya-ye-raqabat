const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: '10kb' }));

app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

const leaderboard = new Map();

app.post('/api/leaderboard',(req,res)=>{
  const name=String(req.body?.name||'').trim().slice(0,24);
  if(!name) return res.status(400).json({error:'name_required'});

  const coins=Math.max(0,Math.min(100000000,Math.floor(Number(req.body.coins)||0)));
  const level=Math.max(0,Math.min(100000,Math.floor(Number(req.body.level)||0)));

  const old=leaderboard.get(name)||{name,coins:0,level:0};
  old.coins=coins;
  old.level=level;
  leaderboard.set(name,old);

  res.json({ok:true});
});

app.get('/api/leaderboard',(req,res)=>{
  const field=req.query.type==='level'?'level':'coins';
  const players=[...leaderboard.values()]
    .sort((a,b)=>b[field]-a[field]||a.name.localeCompare(b.name))
    .slice(0,10)
    .map(p=>({name:p.name,value:p[field]}));

  res.json({type:field,players});
});

let nextRoomId=1;
const waiting=new Map();
const rooms=new Map();
const friendlyRooms=new Map();

function send(ws,data){
  if(ws&&ws.readyState===WebSocket.OPEN)
    ws.send(JSON.stringify(data));
}

function broadcast(room,data){
  room.players.forEach(p=>send(p,data));
}

function friendlyCode(){
  let c;
  do{
    c=Math.random().toString(36).slice(2,8).toUpperCase();
  }while(friendlyRooms.has(c));
  return c;
}

function friendlyPayload(room,type='friendly_update',message=''){
  const data={
    type,
    code:room.code,
    players:room.players.map(p=>({name:p.playerName||'بازیکن'})),
    kind:room.kind||null,
    message
  };
  room.players.forEach(p=>send(p,data));
}

function createFriendly(ws,data){
  if(ws.friendlyRoom||ws.room)
    return send(ws,{type:'error',message:'ابتدا از اتاق قبلی خارج شو.'});

  ws.playerName=String(data.name||'میزبان').slice(0,24);

  const code=friendlyCode();
  const room={
    code,
    players:[ws],
    host:ws,
    kind:null,
    started:false
  };

  friendlyRooms.set(code,room);
  ws.friendlyRoom=room;

  send(ws,{
    type:'friendly_created',
    code,
    players:room.players.map(p=>({name:p.playerName})),
    message:'اتاق ساخته شد؛ کد را برای دوستت بفرست.'
  });
}

function joinFriendly(ws,data){
  const code=String(data.code||'').trim().toUpperCase();
  const room=friendlyRooms.get(code);

  if(!room||room.started)
    return send(ws,{type:'error',message:'اتاقی با این کد پیدا نشد یا مسابقه شروع شده است.'});

  if(ws.friendlyRoom||ws.room)
    return send(ws,{type:'error',message:'ابتدا از اتاق قبلی خارج شو.'});

  const limit=3;

  if(room.players.length>=limit)
    return send(ws,{type:'error',message:'ظرفیت اتاق تکمیل شده است.'});

  ws.playerName=String(data.name||'بازیکن').slice(0,24);
  room.players.push(ws);
  ws.friendlyRoom=room;

  friendlyPayload(room,'friendly_joined','بازیکن جدید وارد اتاق شد.');
}

function startFriendly(ws){
  const room=ws.friendlyRoom;

  if(!room||room.host!==ws||room.started) return;

  const kind=[
    'word','tic','math','speed','mines','dice','fleet'
  ].includes(room.kind)?room.kind:null;

  if(!kind)
    return send(ws,{type:'error',message:'اول یک بازی انتخاب کن.'});

  const needed=kind==='fleet'?3:2;

  if(room.players.length<needed)
    return send(ws,{
      type:'error',
      message:`برای این بازی ${needed} بازیکن لازم است.`
    });

  room.started=true;
  friendlyRooms.delete(room.code);

  const players=room.players.slice(0,needed);
  players.forEach(p=>{p.friendlyRoom=null;});

  const id=nextRoomId++;

  const game={
    id,
    players,
    kind,
    round:kind==='fleet'?1:0,
    scores:Array(needed).fill(0),
    symbols:kind==='fleet'?['P0','P1','P2']:['X','O'],
    board:Array(9).fill(''),
    turn:0,
    answers:new Map(),
    finished:false,
    roundResolved:false,
    mines:[],
    revealed:Array(25).fill(false),
    diceRolled:Array(needed).fill(false),
    phase:kind==='fleet'?'place':undefined,
    ships:kind==='fleet'?[[],[],[]]:undefined,
    shots:kind==='fleet'
      ?Array.from({length:3},()=>Array.from({length:3},()=>Array(36).fill('')))
      :undefined,
    eliminated:kind==='fleet'?[false,false,false]:undefined,
    target:kind==='fleet'?[1,2,0]:undefined
  };

  rooms.set(id,game);

  players.forEach((p,i)=>{
    p.room=game;

    send(p,{
      type:'friendly_started',
      kind,
      room:id,
      symbol:game.symbols[i],
      opponent:players.filter((_,j)=>j!==i).map(x=>x.playerName).join(' و '),
      match:{
        type:'matched',
        room:id,
        kind,
        symbol:game.symbols[i],
        opponent:players.filter((_,j)=>j!==i).map(x=>x.playerName).join(' و ')
      }
    });
  });

  startCountdown(game);
}

function leaveFriendly(ws){
  const r=ws.friendlyRoom;
  if(!r) return;

  r.players=r.players.filter(p=>p!==ws);
  ws.friendlyRoom=null;

  if(!r.players.length){
    friendlyRooms.delete(r.code);
    return;
  }

  if(r.host===ws) r.host=r.players[0];

  friendlyPayload(r,'friendly_update','یک بازیکن از اتاق خارج شد.');
}

const challenges={
  word:[
    {q:'کدام واژه با «آ» شروع می‌شود؟ (آب، میز، کتاب)',a:'آب'},
    {q:'مخالف واژهٔ «سرد» چیست؟',a:'گرم'},
    {q:'جمع «کتاب» چیست؟',a:'کتاب ها'},
    {q:'کدام یک میوه است؟ (سیب، صندلی، مداد)',a:'سیب'},
    {q:'مخالف «بلند» چیست؟',a:'کوتاه'}
  ],
  math:[
    {q:'۷ + ۵ چند می‌شود؟',a:'12'},
    {q:'۹ × ۳ چند می‌شود؟',a:'27'},
    {q:'۲۵ - ۸ چند می‌شود؟',a:'17'},
    {q:'۴۸ ÷ ۶ چند می‌شود؟',a:'8'},
    {q:'۱۰ + ۱۵ چند می‌شود؟',a:'25'}
  ],
  speed:[
    {q:'وقتی علامت شروع را دیدی، سریع دکمه را بزن!',a:'go'},
    {q:'آماده‌ای؟ سریع دکمه را بزن!',a:'go'},
    {q:'مرحله سوم؛ هرچه سریع‌تر!',a:'go'},
    {q:'مرحله چهارم؛ شروع!',a:'go'},
    {q:'مرحله آخر؛ سریع باش!',a:'go'}
  ]
};

app.get('/',(_req,res)=>res.send('Donya Ye Raqabat Server is Online!'));

app.get('/health',(_req,res)=>res.json({
  ok:true,
  waiting:waiting.size,
  rooms:rooms.size
}));

function otherPlayer(room,ws){
  return room.players.find(p=>p!==ws);
}

function scoresFor(room,ws){
  const i=room.players.indexOf(ws);
  return{
    you:room.scores[i],
    opponent:room.scores[1-i]
  };
}

function sendScores(room){
  room.players.forEach(p=>send(p,{
    type:'score',
    ...scoresFor(room,p)
  }));
}

function normalizeAnswer(v){
  return String(v??'')
    .trim()
    .toLowerCase()
    .replace(/ي/g,'ی')
    .replace(/ك/g,'ک')
    .replace(/\s+/g,' ');
}

function startCountdown(room){
  let n=3;

  const tick=()=>{
    if(room.finished) return;

    broadcast(room,{type:'countdown',value:n});

    if(n===0){
      startRound(room);
      return;
    }

    n--;
    setTimeout(tick,1000);
  };

  tick();
}

function makeMines(){
  const a=[];
  while(a.length<3){
    const n=Math.floor(Math.random()*25);
    if(!a.includes(n)) a.push(n);
  }
  return a;
}

function broadcastMines(room,extra={}){
  room.players.forEach(p=>send(p,{
    type:'mines_state',
    round:room.round,
    revealed:room.revealed,
    turn:room.symbols[room.turn],
    ...extra
  }));
}

function startRound(room){
  if(room.finished) return;

  if(room.kind==='fleet'){
    room.phase='place';
    room.ships=[[],[],[]];
    room.shots=Array.from(
      {length:3},
      ()=>Array.from({length:3},()=>Array(36).fill(''))
    );
    room.eliminated=[false,false,false];
    room.target=[1,2,0];
    room.turn=0;

    broadcastFleet(room,'سه خانه برای کشتی‌هایت انتخاب کن.');
    return;
  }

  room.round++;

  if(room.round>5) return finishGame(room);

  room.answers=new Map();
  room.roundResolved=false;

  if(room.kind==='tic'){
    room.board=Array(9).fill('');
    room.turn=(room.round-1)%2;
    broadcastTic(room);
  }else if(room.kind==='dice'){
    room.turn=(room.round-1)%2;
    room.diceRolled=[false,false];
    broadcastDice(room);
  }else if(room.kind==='mines'){
    room.mines=makeMines();
    room.revealed=Array(25).fill(false);
    room.turn=(room.round-1)%2;
    broadcastMines(room);
  }else{
    room.prompt=challenges[room.kind][room.round-1];
    broadcast(room,{
      type:'round_start',
      round:room.round,
      prompt:{q:room.prompt.q}
    });
  }
}

function broadcastDice(room){
  room.players.forEach(p=>send(p,{
    type:'dice_state',
    round:room.round,
    turn:room.symbols[room.turn],
    rolled:room.diceRolled.map((v,i)=>v?room.symbols[i]:null).filter(Boolean)
  }));
}

function broadcastTic(room){
  room.players.forEach(p=>send(p,{
    type:'tic_state',
    board:room.board,
    turn:room.symbols[room.turn],
    round:room.round
  }));
}

function finishRound(room,winnerIndex){
  if(room.roundResolved||room.finished) return;

  room.roundResolved=true;

  if(winnerIndex===0||winnerIndex===1)
    room.scores[winnerIndex]++;

  room.players.forEach((p,i)=>send(p,{
    type:'round_result',
    round:room.round,
    you:room.scores[i],
    opponent:room.scores[1-i],
    message:winnerIndex===-1
      ?'این دست مساوی شد!'
      :winnerIndex===i
        ?'این دست رو بردی! 🎉'
        :'این دست رو حریف برد.'
  }));

  sendScores(room);

  setTimeout(()=>{
    if(room.round>=5) finishGame(room);
    else startRound(room);
  },1600);
}

function finishGame(room){
  if(room.finished) return;

  room.finished=true;

  room.players.forEach((p,i)=>{
    const result=room.scores[i]>room.scores[1-i]
      ?'win'
      :room.scores[i]<room.scores[1-i]
        ?'lose'
        :'draw';

    send(p,{
      type:'game_over',
      result,
      ...scoresFor(room,p)
    });
  });

  setTimeout(()=>{
    room.players.forEach(p=>p.room=null);
    rooms.delete(room.id);
  },30000);
}

function leaveRoom(ws){
  const room=ws.room;
  if(!room) return;

  send(otherPlayer(room,ws),{type:'opponent_left'});

  room.finished=true;
  room.players.forEach(p=>p.room=null);
  rooms.delete(room.id);
}

function joinQueue(ws,data){
  const allowed=['tic','word','math','speed','mines','dice','fleet'];
  const kind=allowed.includes(data.kind)?data.kind:'tic';

  ws.playerName=String(data.name||'بازیکن').slice(0,24);
  ws.kind=kind;

  if(kind==='fleet'){
    let queue=waiting.get(kind)||[];

    queue=queue.filter(p=>p.readyState===WebSocket.OPEN&&!p.room);

    if(!queue.includes(ws)) queue.push(ws);

    if(queue.length<3){
      waiting.set(kind,queue);
      send(ws,{type:'waiting',needed:3,waiting:queue.length});
      return;
    }

    const players=queue.slice(0,3);
    const rest=queue.slice(3);

    if(rest.length) waiting.set(kind,rest);
    else waiting.delete(kind);

    const id=nextRoomId++;

    const room={
      id,players,kind,round:1,
      scores:[0,0,0],
      symbols:['P0','P1','P2'],
      finished:false,
      roundResolved:false,
      phase:'place',
      ships:[[],[],[]],
      shots:Array.from({length:3},()=>Array.from({length:3},()=>Array(36).fill(''))),
      turn:0,
      eliminated:[false,false,false],
      target:[1,2,0]
    };

    rooms.set(id,room);

    players.forEach((p,i)=>{
      p.room=room;
      send(p,{
        type:'matched',
        room:id,
        symbol:room.symbols[i],
        opponent:players.filter((_,j)=>j!==i).map(x=>x.playerName).join(' و '),
        players:players.map(x=>x.playerName)
      });
    });

    startCountdown(room);
    return;
  }

  const opponent=waiting.get(kind);

  if(!opponent||opponent.readyState!==WebSocket.OPEN||opponent.room){
    waiting.set(kind,ws);
    send(ws,{type:'waiting'});
    return;
  }

  waiting.delete(kind);

  const id=nextRoomId++;
  const players=[opponent,ws];

  const room={
    id,players,kind,round:0,
    scores:[0,0],
    symbols:['X','O'],
    board:Array(9).fill(''),
    turn:0,
    answers:new Map(),
    finished:false,
    roundResolved:false,
    mines:[],
    revealed:Array(25).fill(false),
    diceRolled:[false,false]
  };

  rooms.set(id,room);

  players.forEach((p,i)=>{
    p.room=room;
    send(p,{
      type:'matched',
      room:id,
      symbol:room.symbols[i],
      opponent:players[1-i].playerName
    });
  });

  startCountdown(room);
}

function fleetStateFor(room,ws,message){
  const i=room.players.indexOf(ws);
  let targetIndex=room.target[i];

  for(let tries=0;tries<3&&room.eliminated[targetIndex];tries++)
    targetIndex=(targetIndex+1)%3;

  room.target[i]=targetIndex;

  const board=room.phase==='place'
    ?Array.from({length:36},(_,n)=>room.ships[i].includes(n)?'ship':'')
    :room.shots[i][targetIndex];

  const opponents=room.players
    .map((p,j)=>({
      name:p.playerName,
      remaining:room.ships[j].length-
        room.shots.reduce((sum,shotsByTarget)=>sum+
          shotsByTarget[j].filter((v,k)=>v==='hit').length,0),
      alive:!room.eliminated[j]
    }))
    .filter((_,j)=>j!==i);

  send(ws,{
    type:'fleet_state',
    phase:room.phase,
    board,
    opponents,
    placed:room.ships[i].length,
    canShoot:room.phase==='battle'&&room.turn===i&&!room.eliminated[i],
    target:room.players[targetIndex]?.playerName||'',
    turn:room.players[room.turn]?.playerName||'',
    message
  });
}

function broadcastFleet(room,message){
  room.players.forEach(p=>fleetStateFor(room,p,message));
}

function advanceFleetTurn(room){
  for(let step=1;step<=3;step++){
    const n=(room.turn+step)%3;
    if(!room.eliminated[n]){
      room.turn=n;
      return;
    }
  }
}

function fleetFinishIfNeeded(room){
  const alive=room.eliminated
    .map((v,i)=>!v?i:-1)
    .filter(i=>i>=0);

  if(alive.length<=1){
    room.finished=true;

    room.players.forEach((p,i)=>send(p,{
      type:'game_over',
      result:alive[0]===i?'win':'lose',
      you:room.scores[i],
      opponent:0,
      winner:alive.length?room.players[alive[0]].playerName:'بدون برنده'
    }));

    setTimeout(()=>{
      room.players.forEach(p=>p.room=null);
      rooms.delete(room.id);
    },30000);

    return true;
  }

  return false;
}

function handleFleet(room,ws,data){
  const i=room.players.indexOf(ws);

  if(i<0||room.finished) return;

  if(room.phase==='place'&&data.type==='fleet_place'){
    const n=Number(data.index);

    if(!Number.isInteger(n)||n<0||n>=36||
      room.ships[i].length>=3||room.ships[i].includes(n)) return;

    room.ships[i].push(n);

    if(room.ships.every(a=>a.length===3)){
      room.phase='battle';
      room.turn=0;
      broadcastFleet(room,'⚓ همه ناوگان‌ها آماده‌اند! نبرد شروع شد.');
    }else{
      broadcastFleet(room,`کشتی ${room.ships[i].length} از ۳ ثبت شد.`);
    }

    return;
  }

  if(room.phase==='battle'&&data.type==='fleet_shot'){
    if(room.turn!==i||room.eliminated[i]) return;

    const n=Number(data.index);

    if(!Number.isInteger(n)||n<0||n>=36) return;

    let target=room.target[i];

    for(let tries=0;tries<3&&room.eliminated[target];tries++)
      target=(target+1)%3;

    if(target===i||room.shots[i][target][n]) return;

    const hit=room.ships[target].includes(n);
    room.shots[i][target][n]=hit?'hit':'miss';

    const targetHits=room.players.reduce((sum,_p,shooter)=>
      sum+room.shots[shooter][target].filter(v=>v==='hit').length,0);

    if(targetHits>=3) room.eliminated[target]=true;

    room.players.forEach(p=>send(p,{
      type:'fleet_shot',
      shooter:ws.playerName,
      target:room.players[target].playerName,
      index:n,
      result:hit?'hit':'miss',
      message:hit
        ?'💥 برخورد! یکی از کشتی‌های حریف پیدا شد.'
        :'🌊 شلیک به آب خورد!'
    }));

    if(fleetFinishIfNeeded(room)) return;

    advanceFleetTurn(room);

    broadcastFleet(room,hit?'💥 برخورد موفق!':'🌊 این شلیک به آب خورد.');
  }
}

wss.on('connection',ws=>{
  ws.on('message',raw=>{
    let data;

    try{
      data=JSON.parse(raw.toString());
    }catch{
      return send(ws,{type:'error',message:'پیام نامعتبر است.'});
    }

    if(data.type==='find') return joinQueue(ws,data);
    if(data.type==='friendly_create') return createFriendly(ws,data);
    if(data.type==='friendly_join') return joinFriendly(ws,data);

    if(data.type==='friendly_select_game'){
      const fr=ws.friendlyRoom;

      if(!fr||fr.host!==ws)
        return send(ws,{type:'error',message:'فقط میزبان می‌تواند بازی را انتخاب کند.'});

      fr.kind=[
        'word','tic','math','speed','mines','dice','fleet'
      ].includes(data.kind)?data.kind:null;

      return friendlyPayload(fr,'friendly_update','بازی انتخاب شد.');
    }

    if(data.type==='friendly_start') return startFriendly(ws);
    if(data.type==='friendly_leave') return leaveFriendly(ws);

    const room=ws.room;

    if(!room||room.finished)
      return send(ws,{type:'error',message:'اتاق مسابقه پیدا نشد؛ دوباره جست‌وجو کن.'});

    if(data.type==='leave') return leaveRoom(ws);

    if(room.kind==='fleet') return handleFleet(room,ws,data);
    if(room.roundResolved) return;

    if(room.kind==='dice'&&data.type==='dice_roll'){
      const playerIndex=room.players.indexOf(ws);

      if(playerIndex!==room.turn||room.diceRolled[playerIndex]) return;

      room.diceRolled[playerIndex]=true;

      const die1=1+Math.floor(Math.random()*6);
      const die2=1+Math.floor(Math.random()*6);
      const won=die1===6&&die2===6;

      room.players.forEach(p=>send(p,{
        type:'dice_result',
        round:room.round,
        player:room.symbols[playerIndex],
        die1,die2,won,
        message:won?'🎉 جفت شیش! این دست را بردی!':`تاس‌ها ${die1} و ${die2} آمدند.`
      }));

      if(won) return finishRound(room,playerIndex);
      if(room.diceRolled.every(Boolean)) return finishRound(room,-1);

      room.turn=1-room.turn;
      return broadcastDice(room);
    }

    if(room.kind==='mines'&&data.type==='mine_move'){
      const index=Number(data.index);
      const playerIndex=room.players.indexOf(ws);

      if(playerIndex!==room.turn||
        !Number.isInteger(index)||index<0||index>24||
        room.revealed[index]) return;

      room.revealed[index]=true;

      if(room.mines.includes(index)){
        broadcastMines(room,{mines:room.mines});
        return finishRound(room,1-playerIndex);
      }

      if(room.revealed.every(Boolean)){
        broadcastMines(room,{mines:room.mines});
        return finishRound(room,-1);
      }

      room.turn=1-room.turn;
      return broadcastMines(room);
    }

    if(room.kind==='tic'&&data.type==='tic_move'){
      const index=Number(data.index);
      const playerIndex=room.players.indexOf(ws);

      if(playerIndex!==room.turn||
        !Number.isInteger(index)||index<0||index>8||
        room.board[index]) return;

      room.board[index]=room.symbols[playerIndex];

      const b=room.board;
      const wins=[
        [0,1,2],[3,4,5],[6,7,8],
        [0,3,6],[1,4,7],[2,5,8],
        [0,4,8],[2,4,6]
      ];

      const won=wins.some(line=>
        line.every(i=>b[i]===room.symbols[playerIndex])
      );

      if(won){
        broadcastTic(room);
        return finishRound(room,playerIndex);
      }

      if(b.every(Boolean)){
        broadcastTic(room);
        return finishRound(room,-1);
      }

      room.turn=1-room.turn;
      return broadcastTic(room);
    }

    if(room.kind!=='tic'&&room.kind!=='mines'&&
      room.kind!=='dice'&&data.type==='answer'){

      if(Number(data.round)!==room.round||room.answers.has(ws)) return;

      const expected=normalizeAnswer(room.prompt.a);
      const actual=normalizeAnswer(data.answer);

      if(actual!==expected)
        return send(ws,{type:'answer_wrong',message:'جواب درست نیست؛ دوباره تلاش کن.'});

      room.answers.set(ws,true);
      return finishRound(room,room.players.indexOf(ws));
    }
  });

  ws.on('close',()=>{
    for(const[kind,value]of waiting.entries()){
      if(Array.isArray(value)){
        const next=value.filter(p=>p!==ws);
        if(next.length) waiting.set(kind,next);
        else waiting.delete(kind);
      }else if(value===ws){
        waiting.delete(kind);
      }
    }

    leaveRoom(ws);
    leaveFriendly(ws);
  });
});

server.listen(process.env.PORT||3000,'0.0.0.0',()=>{
  console.log('Game server is running!');
});
