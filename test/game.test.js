import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAction,
  buildDeck,
  getPlayerView,
  handPoints,
  startRound,
} from '../game.js';

const stableRng = (n) => 0;

const number = (id, color, value) => ({ id, kind: 'number', color, value });
const action = (id, color, kind = 'skip') => ({ id, kind, color });
const wild = (id, kind = 'wild') => ({ id, kind, color: null });

function makeGame({ playerCount = 4, config = { sniping: 'off' } } = {}) {
  const players = Array.from({ length: playerCount }, (_, index) => ({
    id: `p${index}`,
    name: `玩家${index}`,
  }));
  const { state } = startRound({ players, config, rng: stableRng });
  state.discardPile = [number('top', 'red', 5)];
  state.activeColor = 'red';
  state.currentIndex = 0;
  state.pendingDraw = null;
  state.window = null;
  state.volley = null;
  state.challenge = null;
  state.awaitingColor = null;
  state.drawChoice = null;
  state.finishers = [];
  state.roundOver = false;
  state.phase = 'PLAYING';
  state.log = [];
  state.drawPile = Array.from({ length: 30 }, (_, index) => ({
    id: `deck-${index}`,
    kind: 'number',
    color: ['yellow', 'green', 'blue'][index % 3],
    value: (index % 9) + 1,
  }));
  for (const player of state.players) player.hand = [];
  return state;
}

function give(state, index, cards) {
  state.players[index].hand = cards;
}

test('108 张牌构成符合 Uno 标准', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 108);
  assert.equal(deck.filter((card) => card.kind === 'wild').length, 4);
  assert.equal(deck.filter((card) => card.kind === 'wild4').length, 4);
  for (const color of ['red', 'yellow', 'green', 'blue']) {
    const cards = deck.filter((card) => card.color === color);
    assert.equal(cards.length, 25);
    assert.equal(cards.filter((card) => card.kind === 'number' && card.value === 0).length, 1);
    for (let value = 1; value <= 9; value += 1) {
      assert.equal(cards.filter((card) => card.kind === 'number' && card.value === value).length, 2);
    }
    for (const kind of ['skip', 'reverse', 'draw2']) {
      assert.equal(cards.filter((card) => card.kind === kind).length, 2);
    }
  }
});

test('开局发 7 张，首张 Wild Draw Four 不会留在桌面', () => {
  const { state } = startRound({
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    rng: stableRng,
  });
  assert.ok(state.players.every((player) => player.hand.length === 7 || player.hand.length === 9));
  assert.notEqual(state.discardPile.at(-1).kind, 'wild4');
  assert.equal(state.drawPile.length + state.discardPile.length + state.players.reduce((n, p) => n + p.hand.length, 0), 108);
});

test('颜色匹配和符号匹配可出，非法出牌不改变原状态', () => {
  const state = makeGame();
  give(state, 0, [number('red-9', 'red', 9), action('red-skip', 'red'), number('green-2', 'green', 2)]);
  give(state, 1, [number('x', 'blue', 1)]);
  give(state, 2, [number('y', 'blue', 2)]);
  give(state, 3, [number('z', 'blue', 3)]);

  assert.throws(
    () => applyAction(state, { type: 'playCard', playerId: 'p0', cardId: 'green-2' }),
    (error) => error.code === 'CARD_NOT_PLAYABLE',
  );
  const result = applyAction(state, { type: 'playCard', playerId: 'p0', cardId: 'red-skip' });
  assert.equal(result.state.currentIndex, 2);
  assert.equal(state.players[0].hand.length, 3, '纯函数不应修改旧状态');
  assert.equal(result.state.players[0].hand.length, 2);
});

test('抽牌后只能打刚抽到的牌，也可以直接结束回合', () => {
  const state = makeGame();
  give(state, 0, [number('a0', 'green', 1), number('a1', 'blue', 1)]);
  give(state, 1, [number('b0', 'green', 2)]);
  give(state, 2, [number('c0', 'green', 3)]);
  give(state, 3, [number('d0', 'green', 4)]);
  state.drawPile = [number('later', 'green', 8), number('drawn', 'red', 8)];

  const drawn = applyAction(state, { type: 'drawCard', playerId: 'p0' }).state;
  assert.equal(drawn.drawChoice.playerId, 'p0');
  assert.equal(drawn.drawChoice.cardId, 'drawn');
  assert.throws(
    () => applyAction(drawn, { type: 'playCard', playerId: 'p0', cardId: 'a1' }),
    (error) => error.code === 'ONLY_DRAWN_CARD',
  );
  const played = applyAction(drawn, { type: 'playCard', playerId: 'p0', cardId: 'drawn' }).state;
  assert.equal(played.discardPile.at(-1).id, 'drawn');
  assert.equal(played.currentIndex, 1);

  const state2 = makeGame();
  give(state2, 0, [number('a0', 'green', 1)]);
  give(state2, 1, [number('b0', 'green', 2)]);
  give(state2, 2, [number('c0', 'green', 3)]);
  give(state2, 3, [number('d0', 'green', 4)]);
  state2.drawPile = [number('unplayable', 'blue', 8)];
  const drew = applyAction(state2, { type: 'drawCard', playerId: 'p0' }).state;
  assert.equal(drew.drawChoice, null);
  assert.equal(drew.currentIndex, 1);
});

test('强制抽牌逐张进行，抽到可出牌后仍可继续抽或打出', () => {
  const state = makeGame({ config: { sniping: 'off', forceDrawUntilPlayable: true } });
  give(state, 0, [number('a0', 'green', 1)]);
  give(state, 1, [number('b0', 'green', 2)]);
  give(state, 2, [number('c0', 'green', 3)]);
  give(state, 3, [number('d0', 'green', 4)]);
  state.drawPile = [
    number('play-later', 'red', 9),
    number('bad-2', 'blue', 8),
    number('bad-1', 'green', 8),
  ];

  const first = applyAction(state, { type: 'drawCard', playerId: 'p0' }).state;
  assert.equal(first.players[0].hand.length, 2);
  assert.equal(first.drawChoice.cardId, 'bad-1');
  assert.equal(first.drawChoice.forceDraw, true);
  assert.equal(first.drawChoice.mustPlay, true);
  assert.deepEqual(getPlayerView(first, 'p0').playableCardIds, []);
  assert.equal(first.currentIndex, 0);
  assert.throws(
    () => applyAction(first, { type: 'endTurn', playerId: 'p0' }),
    (error) => error.code === 'MUST_DRAW_OR_PLAY',
  );

  const second = applyAction(first, { type: 'drawCard', playerId: 'p0' }).state;
  assert.equal(second.players[0].hand.length, 3);
  assert.equal(second.drawChoice.cardId, 'bad-2');
  assert.equal(second.drawChoice.forceDraw, true);

  const third = applyAction(second, { type: 'drawCard', playerId: 'p0' }).state;
  assert.equal(third.players[0].hand.length, 4);
  assert.equal(third.drawChoice.cardId, 'play-later');
  assert.equal(third.drawChoice.forceDraw, true);
  assert.equal(third.drawChoice.canPlay, true);
  assert.deepEqual(getPlayerView(third, 'p0').playableCardIds, ['play-later']);
  assert.throws(
    () => applyAction(third, { type: 'endTurn', playerId: 'p0' }),
    (error) => error.code === 'MUST_DRAW_OR_PLAY',
  );
  const played = applyAction(third, { type: 'playCard', playerId: 'p0', cardId: 'play-later' }).state;
  assert.equal(played.currentIndex, 1);
  assert.equal(played.drawChoice, null);
});

test('强制抽牌抽到可出牌后若选择不打，继续抽到的牌成为唯一可出牌', () => {
  const state = makeGame({ config: { sniping: 'off', forceDrawUntilPlayable: true } });
  give(state, 0, [number('a0', 'green', 1)]);
  give(state, 1, [number('b0', 'green', 2)]);
  give(state, 2, [number('c0', 'green', 3)]);
  give(state, 3, [number('d0', 'green', 4)]);
  state.drawPile = [number('after-decline', 'blue', 9), number('first-playable', 'red', 7)];

  const first = applyAction(state, { type: 'drawCard', playerId: 'p0' }).state;
  assert.equal(first.drawChoice.cardId, 'first-playable');
  assert.equal(first.drawChoice.canPlay, true);
  const declined = applyAction(first, { type: 'drawCard', playerId: 'p0' }).state;
  assert.equal(declined.players[0].hand.length, 3);
  assert.equal(declined.drawChoice.cardId, 'after-decline');
  assert.equal(declined.drawChoice.forceDraw, true);
  assert.deepEqual(getPlayerView(declined, 'p0').playableCardIds, []);
  assert.equal(declined.currentIndex, 0);
  const emptyDraw = applyAction(declined, { type: 'drawCard', playerId: 'p0' }).state;
  assert.equal(emptyDraw.roundOver, false);
  assert.equal(emptyDraw.currentIndex, 1);
});

test('强制抽牌规则下，起手有牌可出但选择抽牌也必须抽到能出为止', () => {
  const state = makeGame({ config: { sniping: 'off', forceDrawUntilPlayable: true } });
  give(state, 0, [number('red-start', 'red', 7), number('a0', 'green', 1)]);
  give(state, 1, [number('b0', 'green', 2)]);
  give(state, 2, [number('c0', 'green', 3)]);
  give(state, 3, [number('d0', 'green', 4)]);
  state.drawPile = [number('play-next', 'red', 9), number('bad', 'blue', 8)];
  const firstDraw = applyAction(state, { type: 'drawCard', playerId: 'p0' }).state;
  assert.equal(firstDraw.drawChoice.cardId, 'bad');
  assert.equal(firstDraw.drawChoice.forceDraw, true);
  assert.equal(firstDraw.currentIndex, 0);
  assert.throws(
    () => applyAction(firstDraw, { type: 'endTurn', playerId: 'p0' }),
    (error) => error.code === 'MUST_DRAW_OR_PLAY',
  );
  const secondDraw = applyAction(firstDraw, { type: 'drawCard', playerId: 'p0' }).state;
  assert.equal(secondDraw.drawChoice.cardId, 'play-next');
  assert.equal(secondDraw.drawChoice.canPlay, true);
  assert.deepEqual(getPlayerView(secondDraw, 'p0').playableCardIds, ['play-next']);
  assert.throws(
    () => applyAction(secondDraw, { type: 'endTurn', playerId: 'p0' }),
    (error) => error.code === 'MUST_DRAW_OR_PLAY',
  );
  const played = applyAction(secondDraw, {
    type: 'playCard',
    playerId: 'p0',
    cardId: 'play-next',
  }).state;
  assert.equal(played.currentIndex, 1);
  assert.equal(played.drawChoice, null);
});

test('默认可以叠加 +2，也能关闭叠加', () => {
  const state = makeGame();
  give(state, 0, [action('d2-a', 'red', 'draw2'), number('a0', 'blue', 1)]);
  give(state, 1, [action('d2-b', 'blue', 'draw2'), number('b0', 'green', 2)]);
  give(state, 2, [number('c0', 'green', 3), number('c1', 'green', 4)]);
  give(state, 3, [number('d0', 'green', 5), number('d1', 'green', 6)]);

  const afterA = applyAction(state, { type: 'playCard', playerId: 'p0', cardId: 'd2-a' }).state;
  assert.equal(afterA.pendingDraw.count, 2);
  assert.equal(afterA.currentIndex, 1);
  const afterB = applyAction(afterA, { type: 'playCard', playerId: 'p1', cardId: 'd2-b' }).state;
  assert.equal(afterB.pendingDraw.count, 4);
  assert.equal(afterB.currentIndex, 2);
  const afterC = applyAction(afterB, { type: 'drawCard', playerId: 'p2' }).state;
  assert.equal(afterC.players[2].hand.length, 2 + 4);
  assert.equal(afterC.currentIndex, 3);

  const noStack = makeGame({ config: { sniping: 'off', stackDraws: false } });
  give(noStack, 0, [action('d2-a', 'red', 'draw2'), number('a0', 'blue', 1)]);
  give(noStack, 1, [action('d2-b', 'blue', 'draw2')]);
  give(noStack, 2, [number('c0', 'green', 3)]);
  give(noStack, 3, [number('d0', 'green', 5)]);
  const pending = applyAction(noStack, { type: 'playCard', playerId: 'p0', cardId: 'd2-a' }).state;
  assert.throws(
    () => applyAction(pending, { type: 'playCard', playerId: 'p1', cardId: 'd2-b' }),
    (error) => error.code === 'MUST_DRAW',
  );
});

test('出牌时携带 callUno 视为同时喊 UNO；未喊会被抓', () => {
  const state = makeGame();
  give(state, 0, [number('a0', 'red', 1), number('a1', 'red', 2)]);
  give(state, 1, [number('b0', 'green', 2), number('b1', 'green', 3)]);
  give(state, 2, [number('c0', 'green', 4), number('c1', 'green', 5)]);
  give(state, 3, [number('d0', 'green', 6), number('d1', 'green', 7)]);

  const safePlay = applyAction(state, {
    type: 'playCard',
    playerId: 'p0',
    cardId: 'a1',
    callUno: true,
  }).state;
  assert.equal(safePlay.players[0].hand.length, 1);
  assert.equal(safePlay.players[0].unoCalled, true);
  assert.equal(safePlay.players[0].unoExposed, false);

  const withoutUno = applyAction(state, {
    type: 'playCard',
    playerId: 'p0',
    cardId: 'a1',
  }).state;
  assert.equal(withoutUno.players[0].unoExposed, true);
  const caught = applyAction(withoutUno, {
    type: 'catchUno',
    playerId: 'p1',
    targetId: 'p0',
  }).state;
  assert.equal(caught.players[0].hand.length, 3);
  assert.equal(caught.players[0].unoExposed, false);
});

test('抢出时也可以同时喊 UNO', () => {
  const state = makeGame({ config: { sniping: 'exact' } });
  give(state, 0, [action('skip-a', 'red', 'skip'), number('a0', 'blue', 1), number('a1', 'blue', 2)]);
  give(state, 1, [action('skip-b', 'red', 'skip'), number('b0', 'blue', 3)]);
  give(state, 2, [number('c0', 'blue', 4), number('c1', 'blue', 5)]);
  give(state, 3, [number('d0', 'blue', 6), number('d1', 'blue', 7)]);
  const played = applyAction(state, { type: 'playCard', playerId: 'p0', cardId: 'skip-a' }).state;
  const sniped = applyAction(played, {
    type: 'snipe',
    playerId: 'p1',
    cardId: 'skip-b',
    callUno: true,
  }).state;
  assert.equal(sniped.players[1].hand.length, 1);
  assert.equal(sniped.players[1].unoCalled, true);
  assert.equal(sniped.players[1].unoExposed, false);
});

test('Wild Draw Four 质疑按选色前的颜色判断，且只看颜色不看万能牌', () => {
  const guilty = makeGame({ playerCount: 3 });
  give(guilty, 0, [wild('w4', 'wild4'), action('red-skip', 'red', 'skip'), number('a0', 'green', 2)]);
  give(guilty, 1, [number('b0', 'green', 3), number('b1', 'green', 4)]);
  give(guilty, 2, [number('c0', 'green', 5), number('c1', 'green', 6)]);
  const played = applyAction(guilty, {
    type: 'playCard',
    playerId: 'p0',
    cardId: 'w4',
    chosenColor: 'blue',
  }).state;
  assert.ok(played.challenge);
  assert.equal(played.challenge.offenderHadColor, true);
  assert.equal(played.pendingDraw.count, 4);
  const challenged = applyAction(played, { type: 'challenge', playerId: 'p1' }).state;
  assert.equal(challenged.players[0].hand.length, 2 + 4);
  assert.equal(challenged.players[1].hand.length, 2);
  assert.equal(challenged.currentIndex, 1);

  const innocent = makeGame({ playerCount: 3 });
  give(innocent, 0, [wild('w4', 'wild4'), wild('only-wild'), number('blue-card', 'blue', 1), number('a0', 'green', 2)]);
  give(innocent, 1, [number('b0', 'green', 3), number('b1', 'green', 4)]);
  give(innocent, 2, [number('c0', 'green', 5), number('c1', 'green', 6)]);
  const played2 = applyAction(innocent, {
    type: 'playCard',
    playerId: 'p0',
    cardId: 'w4',
    chosenColor: 'blue',
  }).state;
  assert.equal(played2.challenge.offenderHadColor, false);
  const challenged2 = applyAction(played2, { type: 'challenge', playerId: 'p1' }).state;
  assert.equal(challenged2.players[0].hand.length, 3);
  assert.equal(challenged2.players[1].hand.length, 2 + 6);
  assert.equal(challenged2.currentIndex, 2);
});

test('抢出同名牌后由抢出者下家开始回合，功能牌效果叠加', () => {
  const state = makeGame({ config: { sniping: 'exact' } });
  give(state, 0, [action('skip-a', 'red', 'skip'), number('a0', 'blue', 1), number('a1', 'blue', 2)]);
  give(state, 1, [action('skip-b', 'red', 'skip'), number('b0', 'blue', 3), number('b1', 'blue', 4)]);
  give(state, 2, [action('skip-c', 'red', 'skip'), number('c0', 'blue', 5), number('c1', 'blue', 6)]);
  give(state, 3, [number('d0', 'blue', 7), number('d1', 'blue', 8), number('d2', 'blue', 9)]);

  const played = applyAction(state, { type: 'playCard', playerId: 'p0', cardId: 'skip-a' }).state;
  assert.equal(played.window.kind, 'snipe');
  const view = getPlayerView(played, 'p1');
  assert.deepEqual(view.window.eligibleCardIds, ['skip-b']);
  const snipedB = applyAction(played, { type: 'snipe', playerId: 'p1', cardId: 'skip-b' }).state;
  assert.equal(snipedB.window.kind, 'snipe');
  const snipedC = applyAction(snipedB, { type: 'snipe', playerId: 'p2', cardId: 'skip-c' }).state;
  assert.equal(snipedC.window, null);
  assert.equal(snipedC.direction, 1);
  // 最后抢出者 p2 的下家 p3 起，累计 3 个 Skip，跳过 p0、p1、p2，回到 p2。
  assert.equal(snipedC.currentIndex, 2);
});

test('抢出模式 3 允许跟牌，跟出的 +2 会增加罚抽数', () => {
  const state = makeGame({ config: { sniping: 'follow' } });
  give(state, 0, [action('skip-a', 'red', 'skip'), number('a0', 'blue', 1), number('a1', 'blue', 2)]);
  give(state, 1, [action('skip-b', 'red', 'skip'), action('d2-b', 'red', 'draw2'), number('b0', 'blue', 3)]);
  give(state, 2, [number('c0', 'blue', 4), number('c1', 'blue', 5), number('c2', 'blue', 6)]);
  give(state, 3, [number('d0', 'blue', 7), number('d1', 'blue', 8), number('d2', 'blue', 9)]);

  const played = applyAction(state, { type: 'playCard', playerId: 'p0', cardId: 'skip-a' }).state;
  const sniped = applyAction(played, { type: 'snipe', playerId: 'p1', cardId: 'skip-b' }).state;
  assert.equal(sniped.window.kind, 'follow');
  const followView = getPlayerView(sniped, 'p1');
  assert.deepEqual(followView.window.eligibleCardIds, ['d2-b']);
  const followed = applyAction(sniped, { type: 'follow', playerId: 'p1', cardId: 'd2-b' }).state;
  assert.equal(followed.pendingDraw.count, 2);
  assert.equal(followed.currentIndex, 2);
  assert.equal(followed.pendingDraw.skipAfter, 2);
});

test('最后一手是功能牌时先结算罚抽再结束，并计分', () => {
  const state = makeGame({ playerCount: 3 });
  give(state, 0, [action('last-d2', 'red', 'draw2')]);
  give(state, 1, [number('b0', 'blue', 9), wild('b1')]);
  give(state, 2, [number('c0', 'green', 1)]);
  state.drawPile = [number('x1', 'yellow', 2), number('x2', 'yellow', 3)];
  const result = applyAction(state, { type: 'playCard', playerId: 'p0', cardId: 'last-d2' }).state;
  assert.equal(result.roundOver, true);
  assert.equal(result.roundResult.winnerId, 'p0');
  assert.deepEqual(result.roundResult.finishers, ['p0']);
  assert.equal(result.players[0].score, 0);
  assert.equal(result.players[1].score, handPoints(result.players[1].hand));
  assert.equal(result.players[2].score, handPoints(result.players[2].hand));
  assert.equal(result.roundResult.scoreGained.p0, 0);
  assert.equal(result.players[1].hand.length, 4);
});

test('查看视图绝不泄露其他玩家手牌', () => {
  const state = makeGame();
  give(state, 0, [number('own', 'red', 1)]);
  give(state, 1, [number('secret', 'red', 2)]);
  give(state, 2, [number('c0', 'red', 3)]);
  give(state, 3, [number('d0', 'red', 4)]);
  const view = getPlayerView(state, 'p0');
  assert.deepEqual(view.yourHand.map((card) => card.id), ['own']);
  const opponent = view.players.find((player) => player.id === 'p1');
  assert.equal(opponent.handCount, 1);
  assert.equal(Object.hasOwn(opponent, 'hand'), false);
  assert.equal(Object.hasOwn(view, 'drawPile'), false);
});

test('所有玩家都在抢出中清空手牌时也能安全结束', () => {
  const state = makeGame({ playerCount: 2, config: { sniping: 'exact' } });
  give(state, 0, [number('last-a', 'red', 7)]);
  give(state, 1, [number('last-b', 'red', 7)]);
  const afterFirst = applyAction(state, {
    type: 'playCard',
    playerId: 'p0',
    cardId: 'last-a',
  }).state;
  assert.deepEqual(afterFirst.finishers, ['p0']);
  assert.equal(afterFirst.window.kind, 'snipe');
  assert.equal(afterFirst.roundOver, false);
  const afterSnipe = applyAction(afterFirst, {
    type: 'snipe',
    playerId: 'p1',
    cardId: 'last-b',
  }).state;
  assert.equal(afterSnipe.roundOver, true);
  assert.deepEqual(afterSnipe.finishers, ['p0', 'p1']);
  assert.equal(afterSnipe.roundResult.winnerId, 'p0');
  assert.equal(afterSnipe.roundResult.pointsGained, 0);
  assert.equal(afterSnipe.currentIndex, null);
});

test('最后一张 Wild +4 仍会处理质疑与罚抽，然后结束对局', () => {
  const state = makeGame({ playerCount: 3 });
  give(state, 0, [wild('last-w4', 'wild4')]);
  give(state, 1, [number('b0', 'green', 1), number('b1', 'green', 2)]);
  give(state, 2, [number('c0', 'green', 3)]);
  const played = applyAction(state, {
    type: 'playCard',
    playerId: 'p0',
    cardId: 'last-w4',
    chosenColor: 'blue',
  }).state;
  assert.equal(played.roundOver, false);
  assert.ok(played.challenge);
  const challenged = applyAction(played, { type: 'challenge', playerId: 'p1' }).state;
  assert.equal(challenged.roundOver, true);
  assert.equal(challenged.roundResult.winnerId, 'p0');
  assert.equal(challenged.players[1].hand.length, 2 + 6);
  assert.equal(challenged.players[0].score, 0);
  assert.equal(challenged.players[1].score, handPoints(challenged.players[1].hand));
  assert.equal(challenged.players[2].score, handPoints(challenged.players[2].hand));
  assert.equal(challenged.roundResult.scoreGained.p0, 0);
});

test('叠加打出的 Wild +4 不再触发质疑', () => {
  const state = makeGame({ playerCount: 3 });
  give(state, 0, [wild('w4-a', 'wild4'), number('a0', 'blue', 1)]);
  give(state, 1, [wild('w4-b', 'wild4'), number('b0', 'green', 2)]);
  give(state, 2, [number('c0', 'green', 3), number('c1', 'green', 4)]);
  const base = applyAction(state, {
    type: 'playCard',
    playerId: 'p0',
    cardId: 'w4-a',
    chosenColor: 'blue',
  }).state;
  assert.ok(base.challenge);
  const stacked = applyAction(base, {
    type: 'playCard',
    playerId: 'p1',
    cardId: 'w4-b',
    chosenColor: 'yellow',
  }).state;
  assert.equal(stacked.challenge, null);
  assert.equal(stacked.pendingDraw.count, 8);
  assert.equal(stacked.pendingDraw.top, 'wild4');
  assert.equal(stacked.currentIndex, 2);
});

test('弃牌堆耗尽时会保留顶牌并重新洗牌', () => {
  const state = makeGame({ playerCount: 3 });
  give(state, 0, [number('a0', 'green', 1)]);
  give(state, 1, [number('b0', 'green', 2)]);
  give(state, 2, [number('c0', 'green', 3)]);
  state.discardPile = [number('old1', 'blue', 4), number('old2', 'yellow', 5), number('top', 'red', 5)];
  state.drawPile = [];
  const drawn = applyAction(state, { type: 'drawCard', playerId: 'p0' }).state;
  assert.equal(drawn.discardPile.length, 1);
  assert.equal(drawn.discardPile[0].id, 'top');
  assert.equal(drawn.players[0].hand.length, 2);
});

test('Wild 抽牌后可选颜色，未完成选色不能继续行动', () => {
  const state = makeGame({ playerCount: 3 });
  state.discardPile = [wild('opening-wild', 'wild')];
  state.activeColor = null;
  state.awaitingColor = { playerId: 'p0' };
  give(state, 0, [number('a0', 'blue', 1)]);
  give(state, 1, [number('b0', 'blue', 2)]);
  give(state, 2, [number('c0', 'blue', 3)]);
  assert.throws(
    () => applyAction(state, { type: 'drawCard', playerId: 'p0' }),
    (error) => error.code === 'COLOR_OPEN',
  );
  assert.throws(
    () => applyAction(state, { type: 'chooseColor', playerId: 'p1', color: 'red' }),
    (error) => error.code === 'NOT_COLOR_CHOOSER',
  );
  const chosen = applyAction(state, { type: 'chooseColor', playerId: 'p0', color: 'red' }).state;
  assert.equal(chosen.activeColor, 'red');
  assert.equal(chosen.awaitingColor, null);
});

test('callUno 只能在剩一张时使用；出牌后可立即补喊', () => {
  const state = makeGame();
  give(state, 0, [number('a0', 'red', 1), number('a1', 'red', 2)]);
  give(state, 1, [number('b0', 'green', 2)]);
  give(state, 2, [number('c0', 'green', 3)]);
  give(state, 3, [number('d0', 'green', 4)]);
  assert.throws(
    () => applyAction(state, { type: 'callUno', playerId: 'p0' }),
    (error) => error.code === 'UNO_NOT_ALLOWED',
  );
  const played = applyAction(state, { type: 'playCard', playerId: 'p0', cardId: 'a1' }).state;
  assert.equal(played.players[0].unoExposed, true);
  const saved = applyAction(played, { type: 'callUno', playerId: 'p0' }).state;
  assert.equal(saved.players[0].unoCalled, true);
  assert.equal(saved.players[0].unoExposed, false);
  assert.throws(
    () => applyAction(saved, { type: 'catchUno', playerId: 'p1', targetId: 'p0' }),
    (error) => error.code === 'UNO_SAFE',
  );
});


test('抢出可以主动放弃；所有有资格的玩家都放弃后窗口提前关闭', () => {
  const state = makeGame({ playerCount: 3, config: { sniping: 'exact' } });
  give(state, 0, [action('skip-a', 'red', 'skip'), number('a0', 'blue', 1)]);
  give(state, 1, [action('skip-b', 'red', 'skip'), number('b0', 'blue', 2)]);
  give(state, 2, [action('skip-c', 'red', 'skip'), number('c0', 'blue', 3)]);
  const played = applyAction(state, { type: 'playCard', playerId: 'p0', cardId: 'skip-a' }).state;
  assert.equal(played.window.kind, 'snipe');
  const windowId = played.window.id;
  assert.equal(getPlayerView(played, 'p1').window.canSnipe, true);
  assert.equal(getPlayerView(played, 'p2').window.canSnipe, true);

  const afterP1Pass = applyAction(played, { type: 'passSnipe', playerId: 'p1', windowId }).state;
  assert.equal(afterP1Pass.window.kind, 'snipe');
  const p1View = getPlayerView(afterP1Pass, 'p1');
  assert.equal(p1View.window.passed, true);
  assert.equal(p1View.window.canSnipe, false);
  assert.equal(getPlayerView(afterP1Pass, 'p2').window.canSnipe, true);
  assert.throws(
    () => applyAction(afterP1Pass, { type: 'snipe', playerId: 'p1', cardId: 'skip-b' }),
    (error) => error.code === 'SNIPE_PASSED',
  );

  const afterP2Pass = applyAction(afterP1Pass, { type: 'passSnipe', playerId: 'p2', windowId }).state;
  assert.equal(afterP2Pass.window, null);
  // 基础 Skip 结算后由 p0 的下家被跳过，p2 开始行动。
  assert.equal(afterP2Pass.currentIndex, 2);
});

test('只有持有同名牌的玩家可以放弃当前抢出窗口', () => {
  const state = makeGame({ playerCount: 3, config: { sniping: 'exact' } });
  give(state, 0, [action('skip-a', 'red', 'skip'), number('a0', 'blue', 1)]);
  give(state, 1, [action('skip-b', 'red', 'skip'), number('b0', 'blue', 2)]);
  give(state, 2, [number('c0', 'blue', 3), number('c1', 'blue', 4)]);
  const played = applyAction(state, { type: 'playCard', playerId: 'p0', cardId: 'skip-a' }).state;
  assert.throws(
    () => applyAction(played, { type: 'passSnipe', playerId: 'p2', windowId: played.window.id }),
    (error) => error.code === 'CARD_NOT_MATCH',
  );
  assert.throws(
    () => applyAction(played, { type: 'passSnipe', playerId: 'p1', windowId: 'stale' }),
    (error) => error.code === 'STALE_WINDOW',
  );
  const passed = applyAction(played, { type: 'passSnipe', playerId: 'p1', windowId: played.window.id }).state;
  assert.equal(passed.window, null);
  assert.equal(passed.currentIndex, 2);
});


test('无人可出的 0 点余牌不会产生积分', () => {
  const state = makeGame({ playerCount: 3 });
  give(state, 0, [number('last-red', 'red', 9)]);
  give(state, 1, [number('zero-blue', 'blue', 0)]);
  give(state, 2, [number('one-green', 'green', 1)]);
  state.players[1].score = 7;
  const result = applyAction(state, { type: 'playCard', playerId: 'p0', cardId: 'last-red' }).state;
  assert.equal(result.roundOver, true);
  assert.equal(result.roundResult.winnerId, 'p0');
  assert.equal(result.players[0].score, 0);
  assert.equal(result.players[1].score, 7);
  assert.equal(result.players[2].score, 1);
  assert.equal(result.roundResult.scoreGained.p0, 0);
  assert.equal(result.roundResult.scoreGained.p1, 0);
  assert.equal(result.roundResult.scoreGained.p2, 1);
});

test('最后一张牌被抢出后，抢出牌效果仍会结算后再结束并计分', () => {
  const state = makeGame({ playerCount: 4, config: { sniping: 'exact' } });
  give(state, 0, [action('last-d2', 'red', 'draw2')]);
  give(state, 1, [action('snipe-d2', 'red', 'draw2'), number('b0', 'blue', 1)]);
  give(state, 2, [number('c0', 'green', 2), number('c1', 'green', 3)]);
  give(state, 3, [number('d0', 'green', 4)]);

  const played = applyAction(state, { type: 'playCard', playerId: 'p0', cardId: 'last-d2' }).state;
  assert.equal(played.roundOver, false);
  assert.deepEqual(played.finishers, ['p0']);
  assert.equal(played.window.kind, 'snipe');
  assert.equal(getPlayerView(played, 'p1').window.canSnipe, true);

  const sniped = applyAction(played, { type: 'snipe', playerId: 'p1', cardId: 'snipe-d2' }).state;
  assert.equal(sniped.roundOver, true);
  assert.equal(sniped.roundResult.winnerId, 'p0');
  assert.deepEqual(sniped.finishers, ['p0']);
  assert.equal(sniped.discardPile.at(-1).id, 'snipe-d2');
  assert.equal(sniped.players[1].hand.length, 1);
  assert.equal(sniped.players[2].hand.length, 2 + 4);
  assert.equal(sniped.players[0].score, 0);
  assert.equal(sniped.players[1].score, handPoints(sniped.players[1].hand));
  assert.equal(sniped.players[2].score, handPoints(sniped.players[2].hand));
  assert.equal(sniped.players[3].score, handPoints(sniped.players[3].hand));
});
