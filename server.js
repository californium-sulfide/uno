import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import express from 'express';
import { Server } from 'socket.io';
import {
  applyAction,
  COLORS,
  GameError,
  getPlayerView,
} from './game.js';
import { RoomError, RoomManager, sanitizeConfig } from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  pingTimeout: 20000,
  pingInterval: 10000,
});

const manager = new RoomManager();
const WINDOW_MS = 5000;
const CHALLENGE_MS = 10000;
const OFFLINE_SKIP_MS = 20000;
const TICK_MS = 250;
// +4 意愿随下家手牌数下降，质疑意愿随上家手牌数上升（由仿真调参）
const BOT_WILD4_BASE = 100;
const BOT_WILD4_DECAY = 12;
const BOT_WILD4_MIN = 5;
const BOT_WILD4_MAX = 90;
const BOT_CHALLENGE_BASE = 5;
const BOT_CHALLENGE_PER_CARD = 8;
const BOT_CHALLENGE_MIN = 10;
const BOT_CHALLENGE_MAX = 90;

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: manager.rooms.size, uptime: process.uptime() });
});

function runtimeOf(room) {
  if (!room.runtime) {
    room.runtime = {
      windowId: null,
      windowDeadline: 0,
      challengeId: null,
      challengeDeadline: 0,
      offlineKey: null,
      offlineDeadline: 0,
      botPlan: null,
      lastActionAt: 0,
    };
  }
  return room.runtime;
}

function serverNow() {
  return Date.now();
}

function publicRoomFor(room, playerId) {
  return manager.publicRoom(room, playerId);
}

function mergeGameView(room, player) {
  if (!room.game) return null;
  const view = getPlayerView(room.game, player.id);
  if (!view) return null;
  const roomPlayers = new Map(room.players.map((p) => [p.id, p]));
  const deadlines = {};
  const runtime = runtimeOf(room);
  if (room.game.window) deadlines.window = runtime.windowDeadline;
  if (room.game.challenge) deadlines.challenge = runtime.challengeDeadline;
  if (runtime.offlineKey) deadlines.turn = runtime.offlineDeadline;
  return {
    ...view,
    phase: room.phase,
    code: room.code,
    hostId: room.hostId,
    serverNow: serverNow(),
    deadlines,
    players: view.players.map((p) => {
      const roomPlayer = roomPlayers.get(p.id);
      return {
        ...p,
        isBot: Boolean(roomPlayer?.isBot ?? p.isBot),
        connected: roomPlayer ? roomPlayer.connected : false,
        abandoned: Boolean(roomPlayer?.abandoned),
        isHost: p.id === room.hostId,
      };
    }),
  };
}

function emitRoomUpdate(room) {
  for (const player of room.players) {
    if (!player.socketId) continue;
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket) socket.emit('room:update', publicRoomFor(room, player.id));
  }
}

function emitGameStates(room) {
  if (!room.game) return;
  const gamePlayerIds = new Set(room.game.players.map((p) => p.id));
  for (const player of room.players) {
    if (!player.socketId || !gamePlayerIds.has(player.id)) continue;
    const socket = io.sockets.sockets.get(player.socketId);
    if (!socket) continue;
    const view = mergeGameView(room, player);
    if (view) socket.emit('game:state', view);
  }
}

function emitGameEvents(room, events) {
  if (!events?.length) return;
  io.to(room.code).emit('game:event', {
    at: serverNow(),
    events,
  });
}

function broadcast(room, events = []) {
  emitGameEvents(room, events);
  emitRoomUpdate(room);
  emitGameStates(room);
}

function lobbyPayload() {
  return { at: serverNow(), rooms: manager.publicRooms() };
}

function emitLobbyUpdate() {
  const payload = lobbyPayload();
  for (const socket of io.sockets.sockets.values()) {
    if (!socket.data?.roomCode) socket.emit('lobby:update', payload);
  }
}

function refreshDeadlines(room, now = serverNow()) {
  if (!room.game) return;
  const runtime = runtimeOf(room);
  const state = room.game;

  if (state.window) {
    if (runtime.windowId !== state.window.id) {
      runtime.windowId = state.window.id;
      runtime.windowDeadline = now + WINDOW_MS;
    }
  } else {
    runtime.windowId = null;
    runtime.windowDeadline = 0;
  }

  if (state.challenge) {
    if (runtime.challengeId !== state.challenge.id) {
      runtime.challengeId = state.challenge.id;
      runtime.challengeDeadline = now + CHALLENGE_MS;
    }
  } else {
    runtime.challengeId = null;
    runtime.challengeDeadline = 0;
  }

  const current = state.currentIndex === null ? null : state.players[state.currentIndex];
  const roomPlayer = current ? manager.getPlayer(room, current.id) : null;
  if (
    current &&
    roomPlayer &&
    !roomPlayer.isBot &&
    !roomPlayer.connected &&
    room.phase === 'PLAYING'
  ) {
    const key = [
      current.id,
      state.turnSerial,
      state.awaitingColor ? 'color' : '',
      state.pendingDraw ? `pending${state.pendingDraw.count}` : '',
      state.drawChoice ? 'drawn' : '',
      state.window ? state.window.id : '',
      state.challenge ? state.challenge.id : '',
    ].join(':');
    if (runtime.offlineKey !== key) {
      runtime.offlineKey = key;
      const offlineSince = roomPlayer.disconnectedAt || now;
      runtime.offlineDeadline = Math.max(now + 750, offlineSince + OFFLINE_SKIP_MS);
    }
  } else {
    runtime.offlineKey = null;
    runtime.offlineDeadline = 0;
  }

  if (room.phase !== 'PLAYING' || state.roundOver) {
    runtime.botPlan = null;
    runtime.windowId = null;
    runtime.challengeId = null;
    runtime.offlineKey = null;
  }
}

function resetRuntimeForRound(room) {
  room.runtime = {
    windowId: null,
    windowDeadline: 0,
    challengeId: null,
    challengeDeadline: 0,
    offlineKey: null,
    offlineDeadline: 0,
    botPlan: null,
    lastActionAt: serverNow(),
  };
}

function commitActions(room, actions, { broadcastNow = true, bot = false } = {}) {
  let events = [];
  for (const action of actions) {
    const result = applyAction(room.game, action);
    room.game = result.state;
    events = events.concat(result.events);
  }
  manager.syncScores(room);
  const ended = manager.finishRoundIfNeeded(room);
  room.updatedAt = serverNow();
  const runtime = runtimeOf(room);
  runtime.lastActionAt = serverNow();
  runtime.botPlan = null;
  if (ended) {
    runtime.windowId = null;
    runtime.challengeId = null;
    runtime.offlineKey = null;
    runtime.botPlan = null;
  }
  refreshDeadlines(room);
  if (broadcastNow) {
    broadcast(room, events);
  }
  if (ended) emitLobbyUpdate();
  return { events, ended, bot };
}

function actionError(error) {
  if (error instanceof GameError || error instanceof RoomError) {
    return { code: error.code, message: error.message };
  }
  console.error(error);
  return { code: 'SERVER_ERROR', message: '服务器开小差了，请稍后重试' };
}

function ackFail(ack, socket, error) {
  const payload = { ok: false, ...actionError(error) };
  if (typeof ack === 'function') ack(payload);
  socket.emit('game:error', payload);
}

function ackOk(ack, data = {}) {
  if (typeof ack === 'function') ack({ ok: true, ...data });
}

function sessionContext(socket) {
  const code = socket.data?.roomCode;
  const playerId = socket.data?.playerId;
  const room = code ? manager.getRoom(code) : null;
  if (!room) throw new RoomError('NO_SESSION', '会话已失效，请重新加入房间');
  const player = manager.getPlayer(room, playerId);
  if (!player || player.socketId !== socket.id) {
    throw new RoomError('STALE_SESSION', '会话已在别处恢复');
  }
  return { room, player };
}

function bindSession(socket, room, player, token) {
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
  return {
    ok: true,
    code: room.code,
    playerId: player.id,
    token,
    room: publicRoomFor(room, player.id),
  };
}

function gameContext(socket) {
  const { room, player } = sessionContext(socket);
  if (room.phase !== 'PLAYING' || !room.game) {
    throw new RoomError('NOT_PLAYING', '当前不在对局中');
  }
  if (!room.game.players.some((p) => p.id === player.id)) {
    throw new RoomError('NOT_IN_GAME', '你还没有加入本局游戏');
  }
  return { room, player };
}

function ensureNotInRoom(socket) {
  if (socket.data?.roomCode) throw new RoomError('ALREADY_IN_ROOM', '请先退出当前房间');
}

function runGameAction(socket, action, ack) {
  try {
    const { room, player } = gameContext(socket);
    if (player.isBot) throw new RoomError('BOT_ACTION', '机器人不能由客户端操作');
    if (room.phase !== 'PLAYING') throw new RoomError('NOT_PLAYING', '对局已经结束');
    const result = commitActions(room, [{ ...action, playerId: player.id }]);
    ackOk(ack, { seq: room.game.seq, phase: room.phase, ...result });
    return result;
  } catch (error) {
    ackFail(ack, socket, error);
    return null;
  }
}

function leaveSocketRoom(socket, code) {
  socket.leave(code);
  delete socket.data.roomCode;
  delete socket.data.playerId;
}

function chooseBotColor(hand) {
  const counts = Object.fromEntries(COLORS.map((color) => [color, 0]));
  for (const card of hand) {
    if (card.color) counts[card.color] += 1;
  }
  let best = COLORS[0];
  for (const color of COLORS) {
    if (counts[color] > counts[best]) best = color;
  }
  if (counts[best] === 0) return COLORS[randomInt(COLORS.length)];
  return best;
}

function nextActiveViewPlayer(view) {
  const count = view.players.length;
  for (let offset = 1; offset <= count; offset += 1) {
    const index = ((view.currentPlayerIndex + view.direction * offset) % count + count) % count;
    if (view.players[index].handCount > 0) return view.players[index];
  }
  return null;
}

function botCardScore(card, view, pressure) {
  const weights = {
    number: 20,
    skip: 50,
    reverse: 45,
    draw2: 70,
    wild: 35,
    wild4: 80,
  };
  let score = weights[card.kind] ?? 0;
  if (pressure && ['skip', 'reverse', 'draw2', 'wild4'].includes(card.kind)) score += 60;
  if (card.color === view.activeColor) score += 12;
  if (card.kind === 'number') score += card.value / 10;
  if (view.pendingDraw && card.kind === 'wild4') score += 30;
  return score;
}

function botWild4Chance(nextHandCount) {
  return Math.max(
    BOT_WILD4_MIN,
    Math.min(BOT_WILD4_MAX, BOT_WILD4_BASE - BOT_WILD4_DECAY * Math.max(0, nextHandCount)),
  );
}

function botChallengeChance(offenderHandCount) {
  return Math.max(
    BOT_CHALLENGE_MIN,
    Math.min(
      BOT_CHALLENGE_MAX,
      BOT_CHALLENGE_BASE + BOT_CHALLENGE_PER_CARD * Math.max(0, offenderHandCount),
    ),
  );
}

function chooseBotCard(view) {
  const hand = view.yourHand;
  const playable = new Set(view.playableCardIds);
  const cards = hand.filter((card) => playable.has(card.id));
  if (cards.length === 0) return null;
  const nextPlayer = nextActiveViewPlayer(view);
  const pressure = Boolean(nextPlayer && nextPlayer.handCount <= 2);
  const scored = cards.map((card) => ({ card, score: botCardScore(card, view, pressure) }));
  let chosen = scored[0];
  for (const entry of scored) {
    if (entry.score > chosen.score) chosen = entry;
  }
  if (chosen.card.kind === 'wild4') {
    const colorAlternatives = scored.filter(
      (entry) => entry.card.kind !== 'wild4' && entry.card.color === view.activeColor,
    );
    if (
      colorAlternatives.length > 0
      && randomInt(100) >= botWild4Chance(nextPlayer?.handCount ?? 0)
    ) {
      let alternative = colorAlternatives[0];
      for (const entry of colorAlternatives) {
        if (entry.score > alternative.score) alternative = entry;
      }
      chosen = alternative;
    }
  }
  const remaining = hand.filter((card) => card.id !== chosen.card.id);
  return {
    cardId: chosen.card.id,
    chosenColor:
      chosen.card.kind === 'wild' || chosen.card.kind === 'wild4'
        ? chooseBotColor(remaining)
        : undefined,
  };
}

function withBotUno(player, action) {
  if (player.hand.length === 2 && randomInt(100) < 90) action.callUno = true;
  return action;
}

function findBotTask(room) {
  if (!room.game || room.phase !== 'PLAYING' || room.game.roundOver) return null;
  const state = room.game;
  const gamePlayers = state.players;

  const exposedHuman = gamePlayers.find(
    (player) => !player.isBot && player.unoExposed && player.hand.length === 1,
  );
  const catcher = gamePlayers.find((player) => player.isBot);
  if (exposedHuman && catcher) {
    return {
      key: `catch:${state.seq}:${catcher.id}:${exposedHuman.id}`,
      type: 'catch',
      playerId: catcher.id,
      targetId: exposedHuman.id,
      // 预留两次 250ms tick 的调度延迟，确保实际抓取仍落在 0.2–1s 内
      delay: () => randomInt(200, 500),
    };
  }

  if (state.awaitingColor) {
    const player = gamePlayers[state.currentIndex];
    if (player?.isBot) {
      return { key: `color:${state.turnSerial}:${player.id}`, type: 'color', playerId: player.id, delay: () => randomInt(500, 1100) };
    }
    return null;
  }

  if (state.window) {
    if (state.window.kind === 'follow') {
      const actor = gamePlayers.find((p) => p.id === state.window.playerId);
      if (actor?.isBot) {
        return { key: `follow:${state.window.id}`, type: 'follow', playerId: actor.id, delay: () => randomInt(900, 1600) };
      }
      return null;
    }
    if (state.window.kind === 'snipe') {
      for (const player of gamePlayers) {
        if (!player.isBot) continue;
        const view = getPlayerView(state, player.id);
        if (view?.window?.canSnipe) {
          return {
            key: `snipe:${state.window.id}:${player.id}`,
            type: 'snipe',
            playerId: player.id,
            delay: () => randomInt(700, 1500),
          };
        }
      }
      return null;
    }
  }

  if (state.challenge) {
    const challenger = gamePlayers[state.challenge.challengerIndex];
    if (challenger?.isBot) {
      return {
        key: `challenge:${state.challenge.id}:${challenger.id}`,
        type: 'challenge',
        playerId: challenger.id,
        delay: () => randomInt(1000, 1900),
      };
    }
    return null;
  }

  const current = gamePlayers[state.currentIndex];
  if (current?.isBot) {
    const view = getPlayerView(state, current.id);
    if (state.drawChoice?.playerId === current.id) {
      return {
        key: `drawChoice:${state.turnSerial}:${current.id}`,
        type: 'drawChoice',
        playerId: current.id,
        delay: () => randomInt(800, 1500),
      };
    }
    return {
      key: `turn:${state.turnSerial}:${current.id}`,
      type: 'turn',
      playerId: current.id,
      delay: () => randomInt(900, 1700),
      view,
    };
  }

  return null;
}

function botActionFor(room, task) {
  const state = room.game;
  const player = state.players.find((p) => p.id === task.playerId);
  if (!player || !player.isBot) return null;
  const view = getPlayerView(state, player.id);

  if (task.type === 'color') {
    return { type: 'chooseColor', playerId: player.id, color: chooseBotColor(player.hand) };
  }

  if (task.type === 'catch') {
    const target = state.players.find((p) => p.id === task.targetId);
    if (!target?.unoExposed || target.unoCalled || target.hand.length !== 1) return null;
    return { type: 'catchUno', playerId: player.id, targetId: target.id };
  }

  if (task.type === 'snipe') {
    const cardId = view?.window?.eligibleCardIds?.[0];
    if (!cardId) return null;
    return withBotUno(player, { type: 'snipe', playerId: player.id, cardId });
  }

  if (task.type === 'follow') {
    if (view?.window?.isYou) {
      const cardId = view.window.eligibleCardIds?.[0];
      if (cardId) return withBotUno(player, { type: 'follow', playerId: player.id, cardId });
    }
    return { type: 'follow', playerId: player.id, cardId: null };
  }

  if (task.type === 'challenge') {
    const cards = chooseBotCard(view);
    if (cards) return withBotUno(player, { type: 'playCard', playerId: player.id, ...cards });
    const offenderCount =
      view.players.find((item) => item.id === view.challenge?.offenderId)?.handCount ?? 0;
    if (randomInt(100) < botChallengeChance(offenderCount)) {
      return { type: 'challenge', playerId: player.id };
    }
    return { type: 'drawCard', playerId: player.id };
  }

  if (task.type === 'drawChoice') {
    const cardId = view?.playableCardIds?.[0];
    if (!cardId) {
      if (state.drawChoice?.forceDraw) return { type: 'drawCard', playerId: player.id };
      return { type: 'endTurn', playerId: player.id };
    }
    const card = player.hand.find((c) => c.id === cardId);
    return withBotUno(player, {
      type: 'playCard',
      playerId: player.id,
      cardId,
      chosenColor:
        card && (card.kind === 'wild' || card.kind === 'wild4')
          ? chooseBotColor(player.hand.filter((c) => c.id !== cardId))
          : undefined,
    });
  }

  if (task.type === 'turn') {
    if (state.pendingDraw) {
      const cards = chooseBotCard(view);
      if (cards) return withBotUno(player, { type: 'playCard', playerId: player.id, ...cards });
      return { type: 'drawCard', playerId: player.id };
    }
    const cards = chooseBotCard(view);
    if (cards) return withBotUno(player, { type: 'playCard', playerId: player.id, ...cards });
    return { type: 'drawCard', playerId: player.id };
  }

  return null;
}

function executeBotIfDue(room, now) {
  const runtime = runtimeOf(room);
  const task = findBotTask(room);
  if (!task) {
    runtime.botPlan = null;
    return false;
  }
  if (!runtime.botPlan || runtime.botPlan.key !== task.key) {
    runtime.botPlan = { key: task.key, at: now + task.delay() };
    return false;
  }
  if (now < runtime.botPlan.at) return false;
  const action = botActionFor(room, task);
  runtime.botPlan = null;
  if (!action) return false;
  try {
    commitActions(room, [action], { bot: true });
  } catch (error) {
    console.error('bot action failed', error);
  }
  return true;
}

function executeOfflineTurn(room) {
  const runtime = runtimeOf(room);
  const state = room.game;
  if (!state || state.roundOver) return false;
  const current = state.currentIndex === null ? null : state.players[state.currentIndex];
  if (!current) return false;
  const roomPlayer = manager.getPlayer(room, current.id);
  if (!roomPlayer || roomPlayer.connected || roomPlayer.isBot) return false;
  if (state.window) return false;
  if (state.challenge) {
    try {
      commitActions(room, [{ type: 'timeoutChallenge', challengeId: state.challenge.id }]);
    } catch (error) {
      console.error('offline challenge timeout failed', error);
    }
    return true;
  }
  const actions = [];
  if (state.awaitingColor) {
    actions.push({
      type: 'chooseColor',
      playerId: current.id,
      color: COLORS[randomInt(COLORS.length)],
    });
  }
  actions.push({ type: 'timeoutTurn', playerId: current.id });
  runtime.offlineKey = null;
  runtime.offlineDeadline = 0;
  try {
    commitActions(room, actions);
  } catch (error) {
    console.error('offline timeout failed', error);
  }
  return true;
}

function tickRoom(room, now) {
  if (room.phase !== 'PLAYING' || !room.game) return false;
  const runtime = runtimeOf(room);
  const state = room.game;

  if (state.window && runtime.windowId === state.window.id && runtime.windowDeadline > 0 && now >= runtime.windowDeadline) {
    try {
      commitActions(room, [{ type: 'timeoutWindow', windowId: state.window.id }]);
    } catch (error) {
      console.error('window timeout failed', error);
    }
    return true;
  }

  if (
    state.challenge &&
    runtime.challengeId === state.challenge.id &&
    runtime.challengeDeadline > 0 &&
    now >= runtime.challengeDeadline
  ) {
    try {
      commitActions(room, [{ type: 'timeoutChallenge', challengeId: state.challenge.id }]);
    } catch (error) {
      console.error('challenge timeout failed', error);
    }
    return true;
  }

  if (runtime.offlineKey && runtime.offlineDeadline > 0 && now >= runtime.offlineDeadline) {
    if (executeOfflineTurn(room)) return true;
  }

  if (executeBotIfDue(room, now)) return true;
  return false;
}

function roomTick() {
  const now = serverNow();
  for (const room of manager.rooms.values()) {
    try {
      tickRoom(room, now);
    } catch (error) {
      console.error(`tick room ${room.code} failed`, error);
    }
  }
}

function cleanupRooms() {
  const now = serverNow();
  let deleted = false;
  for (const room of [...manager.rooms.values()]) {
    const humans = room.players.filter((p) => !p.isBot);
    if (humans.length === 0) {
      manager.deleteRoom(room.code);
      deleted = true;
      continue;
    }
    const connectedHumans = humans.filter((p) => p.connected);
    if (connectedHumans.length > 0) continue;
    const lastSeen = Math.max(...humans.map((p) => p.disconnectedAt || p.joinedAt || 0));
    if (now - lastSeen > 30 * 60 * 1000) {
      manager.deleteRoom(room.code);
      deleted = true;
    }
  }
  if (deleted) emitLobbyUpdate();
}

setInterval(roomTick, TICK_MS);
setInterval(cleanupRooms, 60 * 1000);

io.on('connection', (socket) => {
  socket.emit('lobby:update', lobbyPayload());

  socket.on('lobby:list', (_payload, ack) => {
    try {
      ackOk(ack, { rooms: manager.publicRooms() });
    } catch (error) {
      ackFail(ack, socket, error);
    }
  });

  socket.on('room:create', (payload = {}, ack) => {
    try {
      ensureNotInRoom(socket);
      if (manager.rooms.size >= 2000) throw new RoomError('SERVER_BUSY', '服务器房间数量已达上限');
      const { room, player, token } = manager.createRoom({
        name: payload.name,
        socketId: socket.id,
        config: payload.config,
        isPublic: Boolean(payload.isPublic),
      });
      bindSession(socket, room, player, token);
      ackOk(ack, { code: room.code, playerId: player.id, token, room: publicRoomFor(room, player.id) });
      broadcast(room, []);
      emitLobbyUpdate();
    } catch (error) {
      ackFail(ack, socket, error);
    }
  });

  socket.on('room:join', (payload = {}, ack) => {
    try {
      ensureNotInRoom(socket);
      const { room, player, token } = manager.joinRoom({
        code: payload.code,
        name: payload.name,
        socketId: socket.id,
      });
      bindSession(socket, room, player, token);
      ackOk(ack, { code: room.code, playerId: player.id, token, room: publicRoomFor(room, player.id) });
      broadcast(room, []);
      emitLobbyUpdate();
    } catch (error) {
      ackFail(ack, socket, error);
    }
  });

  socket.on('room:rejoin', (payload = {}, ack) => {
    try {
      const targetCode = String(payload.code ?? '').trim().toUpperCase();
      if (socket.data?.roomCode) {
        const current = manager.getRoom(socket.data.roomCode);
        if (!current) {
          leaveSocketRoom(socket, socket.data.roomCode);
        } else {
          if (current.code !== targetCode) {
            throw new RoomError('ALREADY_IN_ROOM', '请先退出当前房间');
          }
          if (socket.data.playerId) {
            const player = manager.getPlayer(current, socket.data.playerId);
            if (player) {
              ackOk(ack, {
                code: current.code,
                playerId: player.id,
                token: player.token,
                room: publicRoomFor(current, player.id),
              });
              emitGameStates(current);
              return;
            }
          }
        }
      }
      const { room, player, oldSocketId } = manager.reconnect({
        code: payload.code,
        token: payload.token,
        socketId: socket.id,
      });
      if (oldSocketId && oldSocketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) {
          oldSocket.leave(room.code);
          oldSocket.emit('session:replaced');
          oldSocket.disconnect(true);
        }
      }
      bindSession(socket, room, player, player.token);
      ackOk(ack, {
        code: room.code,
        playerId: player.id,
        token: player.token,
        room: publicRoomFor(room, player.id),
      });
      refreshDeadlines(room);
      broadcast(room, []);
      emitLobbyUpdate();
    } catch (error) {
      ackFail(ack, socket, error);
    }
  });

  socket.on('room:ready', (payload = {}, ack) => {
    try {
      const { room, player } = sessionContext(socket);
      manager.setReady(room, player.id, payload.ready);
      ackOk(ack);
      broadcast(room, []);
    } catch (error) {
      ackFail(ack, socket, error);
    }
  });

  socket.on('room:setVisibility', (payload = {}, ack) => {
    try {
      const { room, player } = sessionContext(socket);
      const isPublic = manager.setVisibility(room, player.id, payload.isPublic);
      ackOk(ack, { isPublic });
      broadcast(room, []);
      emitLobbyUpdate();
    } catch (error) {
      ackFail(ack, socket, error);
    }
  });

  socket.on('room:updateConfig', (payload = {}, ack) => {
    try {
      const { room, player } = sessionContext(socket);
      manager.setConfig(room, player.id, sanitizeConfig(payload.config));
      ackOk(ack, { config: room.config });
      broadcast(room, []);
      emitLobbyUpdate();
    } catch (error) {
      ackFail(ack, socket, error);
    }
  });

  socket.on('room:addBot', (_payload, ack) => {
    try {
      const { room, player } = sessionContext(socket);
      const bot = manager.addBot(room, player.id);
      ackOk(ack, { botId: bot.id });
      broadcast(room, []);
      emitLobbyUpdate();
    } catch (error) {
      ackFail(ack, socket, error);
    }
  });

  socket.on('room:removeBot', (payload = {}, ack) => {
    try {
      const { room, player } = sessionContext(socket);
      manager.removeBot(room, player.id, payload.botId);
      ackOk(ack);
      broadcast(room, []);
      emitLobbyUpdate();
    } catch (error) {
      ackFail(ack, socket, error);
    }
  });

  socket.on('room:start', (_payload, ack) => {
    try {
      const { room, player } = sessionContext(socket);
      manager.startGame(room, player.id);
      resetRuntimeForRound(room);
      refreshDeadlines(room);
      ackOk(ack, { code: room.code, roundNumber: room.roundNumber });
      io.to(room.code).emit('game:event', {
        at: serverNow(),
        events: [{ type: 'round-start', message: `第 ${room.roundNumber} 局开始` }],
      });
      broadcast(room);
      emitLobbyUpdate();
    } catch (error) {
      ackFail(ack, socket, error);
    }
  });

  socket.on('room:endMatch', (_payload, ack) => {
    try {
      const { room, player } = sessionContext(socket);
      const summary = manager.endMatch(room, player.id);
      ackOk(ack, { matchSummary: summary });
      broadcast(room, [
        { type: 'match-end', message: '本场比赛结束，房主已结束对局' },
      ]);
      emitLobbyUpdate();
    } catch (error) {
      ackFail(ack, socket, error);
    }
  });

  socket.on('room:newMatch', (_payload, ack) => {
    try {
      const { room, player } = sessionContext(socket);
      manager.newMatch(room, player.id);
      resetRuntimeForRound(room);
      ackOk(ack);
      broadcast(room, [{ type: 'new-match', message: '新比赛开始，比分已清零' }]);
      emitLobbyUpdate();
    } catch (error) {
      ackFail(ack, socket, error);
    }
  });

  socket.on('room:leave', (_payload, ack) => {
    try {
      const { room, player } = sessionContext(socket);
      const code = room.code;
      const result = manager.leaveRoom(room, player.id);
      leaveSocketRoom(socket, code);
      ackOk(ack, { left: true, ...result });
      if (!result.deleted) broadcast(room, []);
      emitLobbyUpdate();
    } catch (error) {
      ackFail(ack, socket, error);
    }
  });

  socket.on('game:playCard', (payload = {}, ack) => {
    runGameAction(
      socket,
      {
        type: 'playCard',
        cardId: payload.cardId,
        chosenColor: payload.chosenColor,
        callUno: payload.callUno === true,
      },
      ack,
    );
  });
  socket.on('game:drawCard', (_payload, ack) => {
    runGameAction(socket, { type: 'drawCard' }, ack);
  });
  socket.on('game:endTurn', (_payload, ack) => {
    runGameAction(socket, { type: 'endTurn' }, ack);
  });
  socket.on('game:callUno', (_payload, ack) => {
    runGameAction(socket, { type: 'callUno' }, ack);
  });
  socket.on('game:catchUno', (payload = {}, ack) => {
    runGameAction(socket, { type: 'catchUno', targetId: payload.targetId }, ack);
  });
  socket.on('game:chooseColor', (payload = {}, ack) => {
    runGameAction(socket, { type: 'chooseColor', color: payload.color }, ack);
  });
  socket.on('game:snipe', (payload = {}, ack) => {
    runGameAction(
      socket,
      { type: 'snipe', cardId: payload.cardId, callUno: payload.callUno === true },
      ack,
    );
  });
  socket.on('game:passSnipe', (payload = {}, ack) => {
    runGameAction(socket, { type: 'passSnipe', windowId: payload.windowId }, ack);
  });
  socket.on('game:follow', (payload = {}, ack) => {
    runGameAction(
      socket,
      { type: 'follow', cardId: payload.cardId ?? null, callUno: payload.callUno === true },
      ack,
    );
  });
  socket.on('game:challenge', (_payload, ack) => {
    runGameAction(socket, { type: 'challenge' }, ack);
  });

  socket.on('disconnect', () => {
    const { roomCode, playerId } = socket.data ?? {};
    if (!roomCode || !playerId) return;
    const room = manager.getRoom(roomCode);
    if (!room) return;
    const changed = manager.markDisconnected(room, playerId, socket.id);
    if (!changed) return;
    refreshDeadlines(room);
    broadcast(room, []);
    emitLobbyUpdate();
  });
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, HOST, () => {
    console.log(`Uno server running at http://${HOST}:${PORT}`);
  });
}

export { app, io, manager, server };
