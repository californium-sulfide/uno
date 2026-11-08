import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, startRound } from './game.js';

export const MAX_PLAYERS = 10;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VALID_PHASES = ['LOBBY', 'DEALING', 'PLAYING', 'ROUND_END', 'GAME_END'];
const TRANSITIONS = {
  LOBBY: ['DEALING'],
  DEALING: ['PLAYING'],
  PLAYING: ['ROUND_END'],
  ROUND_END: ['DEALING', 'GAME_END'],
  GAME_END: ['LOBBY'],
};

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

export function sanitizeConfig(input = {}) {
  if (!input || typeof input !== 'object') input = {};
  const config = { ...DEFAULT_CONFIG };
  if (typeof input.stackDraws === 'boolean') config.stackDraws = input.stackDraws;
  if (typeof input.wild4FollowDraw2 === 'boolean') config.wild4FollowDraw2 = input.wild4FollowDraw2;
  if (typeof input.forceDrawUntilPlayable === 'boolean') {
    config.forceDrawUntilPlayable = input.forceDrawUntilPlayable;
  }
  if (['off', 'exact', 'follow'].includes(input.sniping)) config.sniping = input.sniping;
  return config;
}

function cleanName(input) {
  const name = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 16);
  if (!name) throw new RoomError('BAD_NAME', '请输入昵称');
  return name;
}

function cleanCode(input) {
  const code = String(input ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,6}$/.test(code)) throw new RoomError('BAD_CODE', '房间码格式不正确');
  return code;
}

function makeToken() {
  return randomBytes(24).toString('base64url');
}

function makePlayer(name, socketId, isBot = false, token = null) {
  return {
    id: randomUUID(),
    name,
    token,
    socketId,
    isBot,
    connected: true,
    abandoned: false,
    ready: isBot,
    score: 0,
    joinedAt: Date.now(),
    disconnectedAt: null,
  };
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.tokenIndex = new Map();
  }

  createRoom({ name, socketId, config, isPublic = false }) {
    const player = makePlayer(cleanName(name), socketId);
    player.ready = true;
    const token = makeToken();
    player.token = token;
    const code = this.#uniqueCode();
    const room = {
      code,
      phase: 'LOBBY',
      hostId: player.id,
      players: [player],
      config: sanitizeConfig(config),
      isPublic: Boolean(isPublic),
      game: null,
      roundNumber: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      matchSummary: null,
    };
    this.rooms.set(code, room);
    this.tokenIndex.set(token, { code, playerId: player.id });
    return { room, player, token };
  }

  joinRoom({ code: rawCode, name, socketId }) {
    const code = cleanCode(rawCode);
    const room = this.#requireRoom(code);
    if (!['LOBBY', 'ROUND_END'].includes(room.phase)) {
      throw new RoomError('ROOM_LOCKED', '对局进行中，暂时无法加入');
    }
    if (room.players.length >= MAX_PLAYERS) throw new RoomError('ROOM_FULL', '房间已满（最多 10 人）');
    const clean = cleanName(name);
    if (room.players.some((player) => player.name.toLowerCase() === clean.toLowerCase())) {
      throw new RoomError('NAME_TAKEN', '房间里已有同名玩家');
    }
    const player = makePlayer(clean, socketId);
    const token = makeToken();
    player.token = token;
    player.ready = false;
    room.players.push(player);
    room.updatedAt = Date.now();
    this.tokenIndex.set(token, { code, playerId: player.id });
    return { room, player, token };
  }

  reconnect({ code: rawCode, token, socketId }) {
    const code = cleanCode(rawCode);
    const room = this.#requireRoom(code);
    if (!token) throw new RoomError('BAD_TOKEN', '缺少重连凭证');
    const player = room.players.find((p) => p.token === token && !p.isBot);
    if (!player) throw new RoomError('INVALID_TOKEN', '重连凭证无效或已过期');
    const oldSocketId = player.socketId;
    player.socketId = socketId;
    player.connected = true;
    player.disconnectedAt = null;
    room.updatedAt = Date.now();
    return { room, player, oldSocketId };
  }

  getRoom(code) {
    return this.rooms.get(String(code ?? '').toUpperCase()) ?? null;
  }

  requireRoom(code) {
    return this.#requireRoom(String(code ?? '').toUpperCase());
  }

  getPlayer(room, playerId) {
    return room?.players.find((player) => player.id === playerId) ?? null;
  }

  requirePlayer(room, playerId) {
    const player = this.getPlayer(room, playerId);
    if (!player) throw new RoomError('NOT_IN_ROOM', '你不在这个房间中');
    return player;
  }

  markDisconnected(room, playerId, socketId) {
    const player = this.getPlayer(room, playerId);
    if (!player || player.isBot || player.socketId !== socketId) return false;
    player.socketId = null;
    player.connected = false;
    player.disconnectedAt = Date.now();
    room.updatedAt = Date.now();
    return true;
  }

  markConnected(room, playerId, socketId) {
    const player = this.getPlayer(room, playerId);
    if (!player || player.isBot) return false;
    const oldSocketId = player.socketId;
    player.socketId = socketId;
    player.connected = true;
    player.disconnectedAt = null;
    room.updatedAt = Date.now();
    return { oldSocketId };
  }

  leaveRoom(room, playerId) {
    const player = this.getPlayer(room, playerId);
    if (!player) throw new RoomError('NOT_IN_ROOM', '你不在这个房间中');
    if (room.phase === 'PLAYING') {
      this.#removeToken(player);
      player.abandoned = true;
      player.connected = false;
      player.disconnectedAt = Date.now();
      player.socketId = null;
      player.token = null;
      player.isBot = true;
      player.ready = true;
      const gamePlayer = room.game?.players.find((p) => p.id === playerId);
      if (gamePlayer) gamePlayer.isBot = true;
      const humans = room.players.filter((p) => !p.isBot);
      if (humans.length === 0) {
        this.deleteRoom(room.code);
        return { deleted: true, convertedToBot: true };
      }
      if (room.hostId === playerId) this.#transferHost(room);
      room.updatedAt = Date.now();
      return { deleted: false, convertedToBot: true };
    }

    room.players = room.players.filter((p) => p.id !== playerId);
    this.#removeToken(player);
    if (room.players.length === 0) {
      this.deleteRoom(room.code);
      return { deleted: true, convertedToBot: false };
    }
    if (room.hostId === playerId) this.#transferHost(room);
    if (!this.rooms.has(room.code)) return { deleted: true, convertedToBot: false };
    room.updatedAt = Date.now();
    return { deleted: false, convertedToBot: false };
  }

  setReady(room, playerId, ready) {
    if (!['LOBBY', 'ROUND_END'].includes(room.phase)) {
      throw new RoomError('BAD_PHASE', '当前阶段不能更改准备状态');
    }
    const player = this.requirePlayer(room, playerId);
    if (player.isBot) throw new RoomError('BOT_READY', '机器人始终准备');
    player.ready = Boolean(ready);
    if (room.hostId === playerId) player.ready = true;
    room.updatedAt = Date.now();
  }

  setVisibility(room, playerId, isPublic) {
    this.#requireHost(room, playerId);
    room.isPublic = Boolean(isPublic);
    room.updatedAt = Date.now();
    return room.isPublic;
  }

  setConfig(room, playerId, config) {
    this.#requireHost(room, playerId);
    if (!['LOBBY', 'ROUND_END'].includes(room.phase)) {
      throw new RoomError('BAD_PHASE', '对局进行中不能修改规则');
    }
    room.config = sanitizeConfig(config);
    room.updatedAt = Date.now();
  }

  addBot(room, playerId) {
    this.#requireHost(room, playerId);
    if (!['LOBBY', 'ROUND_END'].includes(room.phase)) {
      throw new RoomError('BAD_PHASE', '对局进行中不能添加机器人');
    }
    if (room.players.length >= MAX_PLAYERS) throw new RoomError('ROOM_FULL', '房间已满（最多 10 人）');
    let number = 1;
    const names = new Set(room.players.map((p) => p.name));
    while (names.has(`电脑 ${number}`)) number += 1;
    const bot = makePlayer(`电脑 ${number}`, null, true);
    bot.ready = true;
    room.players.push(bot);
    room.updatedAt = Date.now();
    return bot;
  }

  removeBot(room, playerId, botId) {
    this.#requireHost(room, playerId);
    if (!['LOBBY', 'ROUND_END'].includes(room.phase)) {
      throw new RoomError('BAD_PHASE', '对局进行中不能移除机器人');
    }
    const bot = room.players.find((p) => p.id === botId && p.isBot);
    if (!bot) throw new RoomError('NO_BOT', '机器人不存在');
    room.players = room.players.filter((p) => p.id !== botId);
    room.updatedAt = Date.now();
  }

  startGame(room, playerId, rng) {
    this.#requireHost(room, playerId);
    if (!['LOBBY', 'ROUND_END'].includes(room.phase)) {
      throw new RoomError('BAD_PHASE', '当前阶段不能开始对局');
    }
    if (room.players.length < 2) throw new RoomError('NEED_PLAYERS', '至少需要 2 名玩家');
    if (room.players.length > MAX_PLAYERS) throw new RoomError('ROOM_FULL', '房间人数超出上限');
    const host = this.requirePlayer(room, playerId);
    host.ready = true;
    const notReady = room.players.filter((player) => !player.isBot && player.connected && !player.ready);
    if (notReady.length > 0) {
      throw new RoomError('NOT_READY', `${notReady.map((p) => p.name).join('、')} 尚未准备`);
    }
    const previousPhase = room.phase;
    const previousGame = room.game;
    const nextRound = room.roundNumber + 1;
    this.transition(room, 'DEALING');
    try {
      const players = room.players.map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        score: p.score,
      }));
      const { state } = startRound({
        players,
        config: room.config,
        roundNumber: nextRound,
        rng,
      });
      room.game = state;
      room.roundNumber = nextRound;
      room.matchSummary = null;
      this.transition(room, 'PLAYING');
    } catch (error) {
      room.phase = previousPhase;
      room.game = previousGame;
      throw error;
    }
    room.updatedAt = Date.now();
    return room.game;
  }

  syncScores(room) {
    if (!room.game) return;
    for (const gamePlayer of room.game.players) {
      const player = this.getPlayer(room, gamePlayer.id);
      if (player) player.score = gamePlayer.score;
    }
  }

  finishRoundIfNeeded(room) {
    if (room.phase !== 'PLAYING' || !room.game?.roundOver) return false;
    this.syncScores(room);
    this.transition(room, 'ROUND_END');
    room.updatedAt = Date.now();
    return true;
  }

  endMatch(room, playerId) {
    this.#requireHost(room, playerId);
    if (room.phase !== 'ROUND_END') throw new RoomError('BAD_PHASE', '只能在一局结束后结束整场游戏');
    const standings = [...room.players]
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, 'zh'))
      .map((player, index) => ({
        rank: index + 1,
        playerId: player.id,
        name: player.name,
        score: player.score,
        isBot: player.isBot,
      }));
    room.matchSummary = { standings, endedAt: Date.now() };
    this.transition(room, 'GAME_END');
    room.updatedAt = Date.now();
    return room.matchSummary;
  }

  newMatch(room, playerId) {
    this.#requireHost(room, playerId);
    if (room.phase !== 'GAME_END') throw new RoomError('BAD_PHASE', '当前不能开始新比赛');
    this.transition(room, 'LOBBY');
    room.game = null;
    room.roundNumber = 0;
    room.matchSummary = null;
    for (const player of room.players) {
      player.score = 0;
      player.ready = player.isBot || player.id === room.hostId;
    }
    room.updatedAt = Date.now();
  }

  transition(room, next) {
    if (!VALID_PHASES.includes(next)) throw new RoomError('BAD_PHASE', '未知房间状态');
    const allowed = TRANSITIONS[room.phase] ?? [];
    if (!allowed.includes(next)) {
      throw new RoomError('BAD_TRANSITION', `非法房间状态转移 ${room.phase} → ${next}`);
    }
    room.phase = next;
  }

  deleteRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    for (const player of room.players) this.#removeToken(player);
    this.rooms.delete(code);
  }

  publicRooms(limit = 30) {
    const rooms = [];
    for (const room of this.rooms.values()) {
      if (!room.isPublic) continue;
      if (!['LOBBY', 'ROUND_END', 'PLAYING'].includes(room.phase)) continue;
      const host = this.getPlayer(room, room.hostId);
      if (!host || !host.connected) continue;
      const joinable =
        ['LOBBY', 'ROUND_END'].includes(room.phase) && room.players.length < MAX_PLAYERS;
      rooms.push({
        code: room.code,
        phase: room.phase,
        hostName: host?.name ?? '房主',
        playerCount: room.players.length,
        maxPlayers: MAX_PLAYERS,
        roundNumber: room.roundNumber,
        joinable,
        createdAt: room.createdAt,
        config: { ...room.config },
      });
    }
    rooms.sort((a, b) => Number(b.joinable) - Number(a.joinable) || b.createdAt - a.createdAt);
    return rooms.slice(0, limit);
  }

  publicRoom(room, viewerId = null) {
    const allReady = room.players.every((player) => player.isBot || !player.connected || player.ready);
    return {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      config: room.config,
      isPublic: room.isPublic,
      roundNumber: room.roundNumber,
      maxPlayers: MAX_PLAYERS,
      createdAt: room.createdAt,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        isBot: player.isBot,
        connected: player.connected,
        abandoned: player.abandoned,
        ready: player.ready,
        score: player.score,
        isHost: player.id === room.hostId,
        isYou: player.id === viewerId,
      })),
      youId: viewerId,
      canStart:
        viewerId === room.hostId &&
        ['LOBBY', 'ROUND_END'].includes(room.phase) &&
        room.players.length >= 2 &&
        allReady,
      matchSummary: room.matchSummary,
    };
  }

  #requireRoom(code) {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', '房间不存在或已解散');
    return room;
  }

  #requireHost(room, playerId) {
    if (room.hostId !== playerId) throw new RoomError('NOT_HOST', '只有房主可以执行这个操作');
  }

  #transferHost(room) {
    const candidates = room.players.filter((player) => !player.isBot);
    const next = candidates.find((player) => player.connected) ?? candidates[0] ?? null;
    if (!next) {
      this.deleteRoom(room.code);
      return;
    }
    room.hostId = next.id;
    next.ready = true;
  }

  #removeToken(player) {
    if (!player.token) return;
    this.tokenIndex.delete(player.token);
    player.token = null;
  }

  #uniqueCode() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let code = '';
      for (let i = 0; i < 5; i += 1) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new RoomError('CODE_FAILED', '房间创建失败，请重试');
  }
}

