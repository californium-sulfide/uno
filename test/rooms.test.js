import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../rooms.js';

function makeRoom(manager, name = '房主') {
  return manager.createRoom({ name, socketId: 'socket-host' });
}

test('房间生命周期、准备、开局与断线重连', () => {
  const manager = new RoomManager();
  const { room, player: host, token: hostToken } = makeRoom(manager);
  assert.equal(room.phase, 'LOBBY');
  assert.equal(room.hostId, host.id);
  assert.ok(hostToken);
  assert.equal(manager.publicRoom(room, host.id).players[0].token, undefined);

  const { player: guest, token: guestToken } = manager.joinRoom({
    code: room.code,
    name: '客人',
    socketId: 'socket-guest',
  });
  manager.setReady(room, guest.id, true);
  assert.throws(
    () => manager.startGame(room, guest.id),
    (error) => error.code === 'NOT_HOST',
  );

  manager.startGame(room, host.id, () => 0);
  assert.equal(room.phase, 'PLAYING');
  assert.equal(room.roundNumber, 1);
  assert.equal(room.players.length, 2);
  assert.equal(room.game.players.length, 2);

  assert.equal(manager.markDisconnected(room, guest.id, 'socket-guest'), true);
  assert.equal(manager.getPlayer(room, guest.id).connected, false);
  const rejoined = manager.reconnect({
    code: room.code,
    token: guestToken,
    socketId: 'socket-guest-2',
  });
  assert.equal(rejoined.player.id, guest.id);
  assert.equal(rejoined.player.connected, true);
  assert.equal(rejoined.oldSocketId, null);
  assert.throws(
    () => manager.reconnect({ code: room.code, token: 'bad-token', socketId: 'x' }),
    (error) => error.code === 'INVALID_TOKEN',
  );

  assert.equal(manager.publicRoom(room, guest.id).youId, guest.id);
  assert.equal(manager.publicRoom(room, guest.id).players.find((p) => p.id === guest.id).isYou, true);
});

test('对局中禁止新玩家加入，主动离开时由机器人接管座位', () => {
  const manager = new RoomManager();
  const { room, player: host } = makeRoom(manager);
  const { player: guest } = manager.joinRoom({ code: room.code, name: '客人', socketId: 'sg' });
  manager.setReady(room, guest.id, true);
  manager.startGame(room, host.id, () => 0);

  assert.throws(
    () => manager.joinRoom({ code: room.code, name: '迟到者', socketId: 'late' }),
    (error) => error.code === 'ROOM_LOCKED',
  );
  const result = manager.leaveRoom(room, guest.id);
  assert.equal(result.convertedToBot, true);
  assert.equal(manager.getPlayer(room, guest.id).isBot, true);
  assert.equal(manager.getPlayer(room, guest.id).connected, false);
  assert.equal(room.game.players.find((p) => p.id === guest.id).isBot, true);
});

test('机器人座位、规则清洗和非法阶段操作', () => {
  const manager = new RoomManager();
  const { room, player: host } = makeRoom(manager);
  manager.addBot(room, host.id);
  manager.setConfig(room, host.id, {
    stackDraws: false,
    wild4FollowDraw2: true,
    forceDrawUntilPlayable: true,
    sniping: 'follow',
    ignored: 'value',
  });
  assert.equal(room.config.stackDraws, false);
  assert.equal(room.config.sniping, 'follow');
  assert.equal(Object.hasOwn(room.config, 'ignored'), false);
  assert.throws(
    () => manager.transition(room, 'PLAYING'),
    (error) => error.code === 'BAD_TRANSITION',
  );
  manager.startGame(room, host.id, () => 1);
  assert.equal(room.phase, 'PLAYING');
  assert.throws(
    () => manager.startGame(room, host.id, () => 1),
    (error) => error.code === 'BAD_PHASE',
  );
  assert.throws(
    () => manager.endMatch(room, host.id),
    (error) => error.code === 'BAD_PHASE',
  );
});

test('新比赛会清零积分并恢复到大厅', () => {
  const manager = new RoomManager();
  const { room, player: host } = makeRoom(manager);
  const { player: guest } = manager.joinRoom({ code: room.code, name: '客人', socketId: 'sg' });
  manager.setReady(room, guest.id, true);
  manager.startGame(room, host.id, () => 0);
  room.game.roundOver = true;
  room.game.roundResult = { winnerId: host.id };
  room.game.players[0].score = 42;
  assert.equal(manager.finishRoundIfNeeded(room), true);
  assert.equal(room.phase, 'ROUND_END');
  assert.equal(manager.getPlayer(room, host.id).score, 42);
  const summary = manager.endMatch(room, host.id);
  assert.deepEqual(summary.standings.map((row) => row.score), [0, 42]);
  assert.equal(summary.standings[1].playerId, host.id);
  assert.equal(room.phase, 'GAME_END');
  manager.newMatch(room, host.id);
  assert.equal(room.phase, 'LOBBY');
  assert.equal(room.game, null);
  assert.equal(manager.getPlayer(room, host.id).score, 0);
});

test('积分跨局累计，新加入 ROUND_END 的玩家从 0 分开始', () => {
  const manager = new RoomManager();
  const { room, player: host } = makeRoom(manager);
  const { player: guest } = manager.joinRoom({ code: room.code, name: '客人', socketId: 'sg' });
  manager.setReady(room, guest.id, true);
  manager.startGame(room, host.id, () => 0);
  room.game.roundOver = true;
  room.game.roundResult = { winnerId: host.id };
  room.game.players[0].score = 35;
  room.game.players[1].score = 10;
  manager.finishRoundIfNeeded(room);
  assert.equal(room.phase, 'ROUND_END');

  const { player: newcomer, token } = manager.joinRoom({
    code: room.code,
    name: '新朋友',
    socketId: 'sn',
  });
  assert.ok(token);
  assert.equal(manager.getPlayer(room, newcomer.id).score, 0);
  manager.setReady(room, newcomer.id, true);

  manager.startGame(room, host.id, () => 1);
  assert.equal(room.phase, 'PLAYING');
  assert.equal(room.roundNumber, 2);
  const scores = Object.fromEntries(room.game.players.map((p) => [p.name, p.score]));
  assert.deepEqual(scores, { 房主: 35, 客人: 10, 新朋友: 0 });
  assert.equal(room.game.players.length, 3);
});

test('公开房间只展示公开信息，私人房间不出现在大厅', () => {
  const manager = new RoomManager();
  const { room, player: host } = makeRoom(manager);
  assert.equal(room.isPublic, false);
  assert.deepEqual(manager.publicRooms(), []);
  assert.equal(manager.publicRoom(room, host.id).isPublic, false);

  const { player: guest } = manager.joinRoom({ code: room.code, name: '客人', socketId: 'sg' });
  assert.throws(
    () => manager.setVisibility(room, guest.id, true),
    (error) => error.code === 'NOT_HOST',
  );
  manager.setVisibility(room, host.id, true);
  assert.equal(room.isPublic, true);

  const list = manager.publicRooms();
  assert.equal(list.length, 1);
  const entry = list[0];
  assert.equal(entry.code, room.code);
  assert.equal(entry.hostName, '房主');
  assert.equal(entry.playerCount, 2);
  assert.equal(entry.phase, 'LOBBY');
  assert.equal(entry.joinable, true);
  assert.equal(entry.config.stackDraws, true);
  assert.equal(Object.hasOwn(entry, 'token'), false);
  assert.equal(Object.hasOwn(entry, 'socketId'), false);
  assert.equal(JSON.stringify(entry).includes(host.token), false);

  manager.setVisibility(room, host.id, false);
  assert.deepEqual(manager.publicRooms(), []);

  manager.setVisibility(room, host.id, true);
  manager.setReady(room, guest.id, true);
  manager.startGame(room, host.id, () => 0);
  const playing = manager.publicRooms()[0];
  assert.equal(playing.phase, 'PLAYING');
  assert.equal(playing.joinable, false);

  room.game.roundOver = true;
  room.game.roundResult = { winnerId: host.id };
  manager.finishRoundIfNeeded(room);
  const between = manager.publicRooms()[0];
  assert.equal(between.phase, 'ROUND_END');
  assert.equal(between.joinable, true);

  manager.endMatch(room, host.id);
  assert.deepEqual(manager.publicRooms(), []);

  manager.newMatch(room, host.id);
  assert.equal(manager.publicRooms()[0].phase, 'LOBBY');
});

test('创建时可以直接指定公开房间', () => {
  const manager = new RoomManager();
  const { room } = manager.createRoom({ name: '公开房主', socketId: 's', isPublic: true });
  assert.equal(room.isPublic, true);
  const [entry] = manager.publicRooms();
  assert.equal(entry.hostName, '公开房主');
});

test('大厅不会展示所有玩家都已离线的公开房间', () => {
  const manager = new RoomManager();
  const { room, player: host, token } = manager.createRoom({
    name: '房主',
    socketId: 'socket-host',
    isPublic: true,
  });
  assert.equal(manager.publicRooms().length, 1);
  manager.markDisconnected(room, host.id, 'socket-host');
  assert.deepEqual(manager.publicRooms(), []);
  manager.reconnect({ code: room.code, token, socketId: 'socket-host-2' });
  assert.equal(manager.publicRooms().length, 1);
});
