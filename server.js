'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const FIGHTERS = new Set([
  'luffy', 'law', 'zoro', 'sanji', 'ace', 'sabo', 'shanks', 'mihawk', 'kaido',
  'katakuri', 'doflamingo', 'akainu', 'roger', 'whitebeard', 'yamato', 'kizaru',
  'aokiji', 'hancock', 'jinbe', 'enel'
]);
const ARENAS = ['baratie', 'marineford', 'skypiea', 'onigashima'];
const INPUT_ACTIONS = new Set([
  'left', 'right', 'block', 'jump', 'dash', 'fast', 'heavy', 'sp1', 'sp2', 'sp3', 'ult'
]);
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_CHAT_PER_MINUTE = 8;

const rooms = new Map();
const roomCodes = new Map();
const matchmakingQueue = [];
const pendingChallenges = new Map();
const clients = new Set();

function cleanText(value, maxLength, fallback = '') {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, maxLength) || fallback;
}

function safeName(value) {
  return cleanText(value, 18, 'CAPITAINE').replace(/\s+/g, ' ');
}

function safeFighter(value) {
  return FIGHTERS.has(value) ? value : 'luffy';
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(payload)); } catch { /* socket may close between checks */ }
  }
}

function allConnected() {
  return [...clients].filter(ws => ws.readyState === WebSocket.OPEN && ws.meta);
}

function roomPlayers(room) {
  return room.players.filter(ws => ws && ws.readyState === WebSocket.OPEN);
}

function presence() {
  const activeRooms = [...rooms.values()].filter(room => room.started && roomPlayers(room).length === 2);
  const playing = activeRooms.reduce((total, room) => total + roomPlayers(room).length, 0);
  const waitingPrivate = [...rooms.values()].filter(room => !room.started && roomPlayers(room).length === 1).length;
  return {
    online: allConnected().length,
    playing,
    waiting: matchmakingQueue.filter(ws => ws.readyState === WebSocket.OPEN).length + waitingPrivate
  };
}

function lobbyPlayers() {
  return allConnected().slice(0, 50).map(ws => {
    const room = ws.meta.roomId ? rooms.get(ws.meta.roomId) : null;
    return {
      id: ws.meta.id,
      name: ws.meta.name,
      state: room ? (room.started ? 'EN COMBAT' : 'SALON PRIVÉ') : (ws.meta.inQueue ? 'RECHERCHE' : 'EN LIGNE')
    };
  });
}

function broadcastPresence() {
  const stats = presence();
  for (const ws of allConnected()) send(ws, { type: 'presence', ...stats });
  broadcastLobbyPlayers();
}

function broadcastLobbyPlayers() {
  const players = lobbyPlayers();
  for (const ws of allConnected()) send(ws, { type: 'lobby_players', players });
}

function removeFromQueue(ws) {
  const index = matchmakingQueue.indexOf(ws);
  if (index !== -1) matchmakingQueue.splice(index, 1);
  if (ws.meta) ws.meta.inQueue = false;
}

function removeFromRoom(ws, tellOpponent = true) {
  const roomId = ws.meta?.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (room) {
    const opponent = room.players.find(player => player && player !== ws);
    if (tellOpponent && opponent) send(opponent, { type: 'opponent_left', message: 'L’autre joueur a quitté le salon.' });
    if (room.code) roomCodes.delete(room.code);
    rooms.delete(roomId);
    for (const player of room.players) {
      if (player?.meta) {
        player.meta.roomId = null;
        player.meta.slot = 0;
        player.meta.inQueue = false;
      }
    }
  } else if (ws.meta) {
    ws.meta.roomId = null;
    ws.meta.slot = 0;
  }
  broadcastPresence();
}

function detachClient(ws) {
  clearChallengesFor(ws, 'Le joueur n’est plus disponible.');
  removeFromQueue(ws);
  removeFromRoom(ws, true);
  clients.delete(ws);
  broadcastPresence();
}

function createRoomCode() {
  let code;
  do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); }
  while (roomCodes.has(code));
  return code;
}

function playerRecord(ws) {
  return {
    name: ws.meta.name,
    fighterId: ws.meta.fighterId,
    slot: ws.meta.slot
  };
}

function startRoom(room) {
  if (room.started || roomPlayers(room).length !== 2) return;
  room.started = true;
  room.rematch.clear();
  const players = room.players.map(playerRecord);
  const arenaId = ARENAS[Math.floor(Math.random() * ARENAS.length)];
  room.players.forEach((ws, index) => {
    send(ws, {
      type: 'match_found',
      roomId: room.id,
      code: room.code || null,
      slot: index + 1,
      players,
      arenaId
    });
  });
  broadcastPresence();
}

function makeRoom(first, second, code = null) {
  clearChallengesFor(first, 'Le joueur est déjà entré dans un combat.');
  clearChallengesFor(second, 'Le joueur est déjà entré dans un combat.');
  const room = {
    id: crypto.randomUUID(),
    code,
    players: [first, second],
    started: false,
    rematch: new Set(),
    createdAt: Date.now()
  };
  rooms.set(room.id, room);
  if (code) roomCodes.set(code, room.id);
  [first, second].forEach((ws, index) => {
    removeFromQueue(ws);
    ws.meta.roomId = room.id;
    ws.meta.slot = index + 1;
  });
  startRoom(room);
  return room;
}

function joinQueue(ws, payload) {
  removeFromRoom(ws, true);
  removeFromQueue(ws);
  ws.meta.name = safeName(payload.name || ws.meta.name);
  ws.meta.fighterId = safeFighter(payload.fighterId || ws.meta.fighterId);
  // Prune stale entries before matching so one disconnected socket cannot block the queue.
  for (let index = matchmakingQueue.length - 1; index >= 0; index--) {
    const candidate = matchmakingQueue[index];
    if (!candidate || candidate.readyState !== WebSocket.OPEN || !candidate.meta || candidate.meta.roomId) {
      matchmakingQueue.splice(index, 1);
      if (candidate?.meta) candidate.meta.inQueue = false;
    }
  }
  const opponentIndex = matchmakingQueue.findIndex(candidate => candidate !== ws && candidate.meta?.inQueue);
  if (opponentIndex === -1) {
    ws.meta.inQueue = true;
    matchmakingQueue.push(ws);
    send(ws, { type: 'queue_waiting', message: 'Tu es dans la file : partage le lien du jeu à un ami pour qu’il rejoigne le même serveur.' });
  } else {
    const opponent = matchmakingQueue.splice(opponentIndex, 1)[0];
    if (opponent.meta) opponent.meta.inQueue = false;
    makeRoom(opponent, ws);
  }
  broadcastPresence();
}

function createPrivateRoom(ws, payload) {
  clearChallengesFor(ws, 'Le joueur a choisi de créer un salon privé.');
  removeFromQueue(ws);
  removeFromRoom(ws, true);
  ws.meta.name = safeName(payload.name || ws.meta.name);
  ws.meta.fighterId = safeFighter(payload.fighterId || ws.meta.fighterId);
  const code = createRoomCode();
  const room = {
    id: crypto.randomUUID(),
    code,
    players: [ws],
    started: false,
    rematch: new Set(),
    createdAt: Date.now()
  };
  rooms.set(room.id, room);
  roomCodes.set(code, room.id);
  ws.meta.roomId = room.id;
  ws.meta.slot = 1;
  send(ws, { type: 'room_created', code });
  send(ws, { type: 'room_waiting', message: `Salon ${code} créé : partage le code à ton adversaire.` });
  broadcastPresence();
}

function joinPrivateRoom(ws, payload) {
  const code = cleanText(payload.code, 6).toUpperCase();
  const roomId = roomCodes.get(code);
  const room = roomId ? rooms.get(roomId) : null;
  if (room && room.players.includes(ws)) {
    send(ws, { type: 'error', message: 'Tu es déjà dans ce salon : partage le code à ton ami.' });
    return;
  }
  if (!room || room.started || roomPlayers(room).length !== 1) {
    send(ws, { type: 'error', message: 'Code invalide, salon plein ou salon fermé.' });
    return;
  }
  clearChallengesFor(ws, 'Le joueur a rejoint un salon privé.');
  removeFromQueue(ws);
  removeFromRoom(ws, true);
  ws.meta.name = safeName(payload.name || ws.meta.name);
  ws.meta.fighterId = safeFighter(payload.fighterId || ws.meta.fighterId);
  room.players.push(ws);
  ws.meta.roomId = room.id;
  ws.meta.slot = 2;
  startRoom(room);
}

function clearChallenge(challengeId) {
  const challenge = pendingChallenges.get(challengeId);
  if (!challenge) return null;
  clearTimeout(challenge.timer);
  pendingChallenges.delete(challengeId);
  return challenge;
}

function clearChallengesFor(ws, reason = 'Le défi a été annulé.') {
  for (const [challengeId, challenge] of pendingChallenges) {
    if (challenge.from !== ws && challenge.to !== ws) continue;
    clearChallenge(challengeId);
    const other = challenge.from === ws ? challenge.to : challenge.from;
    send(other, { type: 'challenge_cancelled', message: reason });
  }
}

function sendChallenge(ws, targetId) {
  const target = allConnected().find(candidate => candidate.meta.id === targetId);
  if (!target || target === ws) {
    send(ws, { type: 'error', message: 'Ce joueur n’est plus en ligne.' });
    return;
  }
  if (ws.meta.roomId) {
    send(ws, { type: 'error', message: 'Quitte ton salon actuel avant de défier un joueur.' });
    return;
  }
  if (target.meta.roomId) {
    send(ws, { type: 'error', message: `${target.meta.name} est déjà dans un salon ou un combat.` });
    return;
  }
  if ([...pendingChallenges.values()].some(challenge => challenge.to === target)) {
    send(ws, { type: 'error', message: `${target.meta.name} a déjà reçu un défi.` });
    return;
  }

  removeFromQueue(ws);
  const challengeId = crypto.randomUUID();
  const challenge = { from: ws, to: target, createdAt: Date.now(), timer: null };
  challenge.timer = setTimeout(() => {
    if (!clearChallenge(challengeId)) return;
    send(ws, { type: 'challenge_expired', message: `Le défi envoyé à ${target.meta?.name || 'ce joueur'} a expiré.` });
    send(target, { type: 'challenge_expired', message: 'Le défi a expiré.' });
    broadcastPresence();
  }, 30000);
  pendingChallenges.set(challengeId, challenge);
  send(target, {
    type: 'challenge_received',
    challengeId,
    fromId: ws.meta.id,
    fromName: ws.meta.name,
    fighterId: ws.meta.fighterId,
    expiresIn: 30
  });
  send(ws, { type: 'challenge_sent', challengeId, targetName: target.meta.name, expiresIn: 30 });
  broadcastPresence();
}

function acceptChallenge(ws, challengeId) {
  const challenge = pendingChallenges.get(String(challengeId || ''));
  if (!challenge || challenge.to !== ws) {
    send(ws, { type: 'error', message: 'Ce défi n’est plus disponible.' });
    return;
  }
  const inviter = challenge.from;
  if (inviter.readyState !== WebSocket.OPEN || ws.readyState !== WebSocket.OPEN || inviter.meta.roomId || ws.meta.roomId) {
    clearChallenge(challengeId);
    send(ws, { type: 'error', message: 'Un des joueurs est déjà occupé. Relance le défi.' });
    send(inviter, { type: 'challenge_cancelled', message: 'Le défi n’a pas pu démarrer.' });
    return;
  }

  clearChallenge(challengeId);
  clearChallengesFor(inviter, 'Le joueur a accepté un autre défi.');
  clearChallengesFor(ws, 'Le joueur a accepté un autre défi.');
  makeRoom(inviter, ws);
}

function declineChallenge(ws, challengeId) {
  const challenge = pendingChallenges.get(String(challengeId || ''));
  if (!challenge || challenge.to !== ws) return;
  clearChallenge(challengeId);
  send(challenge.from, { type: 'challenge_declined', name: ws.meta.name });
  send(ws, { type: 'challenge_declined_local', name: challenge.from.meta.name });
  broadcastPresence();
}

function relayInput(ws, payload) {
  const room = rooms.get(ws.meta?.roomId);
  if (!room || !room.started || !INPUT_ACTIONS.has(payload.action)) return;
  const opponent = room.players.find(player => player !== ws);
  if (!opponent) return;
  send(opponent, {
    type: 'remote_input',
    action: payload.action,
    pressed: !!payload.pressed
  });
}

function relaySnapshot(ws, payload) {
  const room = rooms.get(ws.meta?.roomId);
  if (!room || !room.started || room.players[0] !== ws || !payload.snapshot) return;
  const opponent = room.players[1];
  const raw = JSON.stringify(payload.snapshot);
  if (raw.length > 110000) return;
  send(opponent, { type: 'battle_snapshot', snapshot: payload.snapshot });
}

function handleChat(ws, payload) {
  const now = Date.now();
  ws.meta.chatTimes = (ws.meta.chatTimes || []).filter(time => now - time < 60000);
  if (ws.meta.chatTimes.length >= MAX_CHAT_PER_MINUTE) {
    send(ws, { type: 'error', message: 'Doucement sur le chat : limite de messages atteinte.' });
    return;
  }
  const message = cleanText(payload.message, 180);
  if (!message) return;
  ws.meta.chatTimes.push(now);
  const packet = { type: 'chat_message', name: ws.meta.name, message, timestamp: now };
  for (const target of allConnected()) send(target, packet);
}

function handleMessage(ws, payload) {
  switch (payload.type) {
    case 'hello':
    case 'profile_update':
      ws.meta.name = safeName(payload.name || ws.meta.name);
      ws.meta.fighterId = safeFighter(payload.fighterId || ws.meta.fighterId);
      if (payload.type === 'hello') send(ws, { type: 'welcome', clientId: ws.meta.id, presence: presence(), players: lobbyPlayers() });
      broadcastPresence();
      break;
    case 'queue_join':
      clearChallengesFor(ws, 'Le joueur est parti en matchmaking.');
      joinQueue(ws, payload);
      break;
    case 'queue_cancel':
      removeFromQueue(ws);
      send(ws, { type: 'queue_cancelled' });
      broadcastPresence();
      break;
    case 'challenge_invite':
      ws.meta.name = safeName(payload.name || ws.meta.name);
      ws.meta.fighterId = safeFighter(payload.fighterId || ws.meta.fighterId);
      sendChallenge(ws, cleanText(payload.targetId, 64));
      break;
    case 'challenge_accept':
      acceptChallenge(ws, cleanText(payload.challengeId, 64));
      break;
    case 'challenge_decline':
      declineChallenge(ws, cleanText(payload.challengeId, 64));
      break;
    case 'create_room':
      createPrivateRoom(ws, payload);
      break;
    case 'join_room':
      joinPrivateRoom(ws, payload);
      break;
    case 'room_leave':
      removeFromQueue(ws);
      removeFromRoom(ws, true);
      break;
    case 'player_input':
      relayInput(ws, payload);
      break;
    case 'battle_snapshot':
      relaySnapshot(ws, payload);
      break;
    case 'match_result': {
      const room = rooms.get(ws.meta?.roomId);
      if (!room || room.players[0] !== ws) return;
      send(room.players[1], { type: 'match_result', p1Won: !!payload.p1Won });
      break;
    }
    case 'rematch_request': {
      const room = rooms.get(ws.meta?.roomId);
      if (!room || !room.started) return;
      room.rematch.add(ws);
      if (room.rematch.size === 2) {
        room.rematch.clear();
        room.players.forEach(player => send(player, { type: 'rematch_start' }));
      } else {
        send(ws, { type: 'rematch_waiting' });
      }
      break;
    }
    case 'chat_message':
      handleChat(ws, payload);
      break;
    case 'ping':
      send(ws, { type: 'pong', at: Date.now() });
      break;
  }
}

function serveStatic(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, ...presence() }));
    return;
  }
  let requested = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const filePath = path.resolve(ROOT, `.${requested}`);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
  if (pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});

wss.on('connection', ws => {
  ws.meta = {
    id: crypto.randomUUID(),
    name: 'CAPITAINE',
    fighterId: 'luffy',
    roomId: null,
    slot: 0,
    inQueue: false,
    chatTimes: [],
    alive: true
  };
  clients.add(ws);
  ws.on('pong', () => { if (ws.meta) ws.meta.alive = true; });
  ws.on('message', raw => {
    if (raw.length > MAX_MESSAGE_BYTES) return ws.close(1009, 'Message too large');
    try {
      const payload = JSON.parse(raw.toString());
      if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return;
      handleMessage(ws, payload);
    } catch {
      send(ws, { type: 'error', message: 'Message invalide.' });
    }
  });
  ws.on('close', () => detachClient(ws));
  ws.on('error', () => detachClient(ws));
  send(ws, { type: 'welcome', clientId: ws.meta.id, presence: presence(), players: lobbyPlayers() });
  broadcastPresence();
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.meta && !ws.meta.alive) { ws.terminate(); continue; }
    if (ws.meta) ws.meta.alive = false;
    try { ws.ping(); } catch { ws.terminate(); }
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`PIRATE CLASH server ready on http://${HOST}:${PORT}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
