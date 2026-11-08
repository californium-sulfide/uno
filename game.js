import { randomInt } from 'node:crypto';

export const COLORS = ['red', 'yellow', 'green', 'blue'];
export const ACTION_KINDS = ['skip', 'reverse', 'draw2'];
export const DEFAULT_CONFIG = Object.freeze({
  stackDraws: true,
  wild4FollowDraw2: false,
  forceDrawUntilPlayable: false,
  sniping: 'exact',
});

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

const defaultRng = (max) => randomInt(0, max);

function assertColor(color) {
  if (!COLORS.includes(color)) throw new GameError('BAD_COLOR', '请选择有效颜色');
}

function clone(value) {
  return structuredClone(value);
}

function cardPoints(card) {
  if (card.kind === 'number') return card.value;
  if (card.kind === 'wild' || card.kind === 'wild4') return 50;
  return 20;
}

export function handPoints(hand) {
  return hand.reduce((sum, card) => sum + cardPoints(card), 0);
}

export function buildDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push({ id: `${color}-0-a`, kind: 'number', color, value: 0 });
    for (let value = 1; value <= 9; value += 1) {
      deck.push({ id: `${color}-${value}-a`, kind: 'number', color, value });
      deck.push({ id: `${color}-${value}-b`, kind: 'number', color, value });
    }
    for (const kind of ACTION_KINDS) {
      deck.push({ id: `${color}-${kind}-a`, kind, color });
      deck.push({ id: `${color}-${kind}-b`, kind, color });
    }
  }
  for (let i = 0; i < 4; i += 1) {
    deck.push({ id: `wild-${i}`, kind: 'wild', color: null });
    deck.push({ id: `wild4-${i}`, kind: 'wild4', color: null });
  }
  return deck;
}

export function shuffle(deck, rng = defaultRng) {
  const result = [...deck];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = rng(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function drawOne(game, rng) {
  if (game.drawPile.length === 0) {
    if (game.discardPile.length <= 1) return null;
    const top = game.discardPile.pop();
    const recycled = game.discardPile;
    game.discardPile = [top];
    game.drawPile = shuffle(recycled, rng);
  }
  return game.drawPile.pop() ?? null;
}

function giveCards(game, player, count, rng) {
  let actual = 0;
  for (let i = 0; i < count; i += 1) {
    const card = drawOne(game, rng);
    if (!card) break;
    player.hand.push(card);
    actual += 1;
  }
  if (actual > 0 && player.hand.length > 1) {
    player.unoCalled = false;
    player.unoExposed = false;
  }
  return actual;
}

function addLog(state, message, type = 'info') {
  state.log.push({ message, type, seq: ++state.logSeq });
  if (state.log.length > 60) state.log.splice(0, state.log.length - 60);
}

function activePlayerCount(state) {
  return state.players.filter((player) => player.hand.length > 0).length;
}

function stepIndex(state, from, direction = state.direction) {
  const count = state.players.length;
  for (let offset = 1; offset <= count; offset += 1) {
    const index = ((from + direction * offset) % count + count) % count;
    if (state.players[index].hand.length > 0) return index;
  }
  return null;
}

function skipIndexes(state, from, count) {
  let index = from;
  for (let i = 0; i < count; i += 1) {
    const next = stepIndex(state, index);
    if (next === null) return null;
    index = next;
  }
  return index;
}

function isPlayableAgainstTop(state, card) {
  if (card.kind === 'wild' || card.kind === 'wild4') return true;
  if (card.color === state.activeColor) return true;
  const top = state.discardPile[state.discardPile.length - 1];
  if (!top) return true;
  if (top.kind === 'number' && card.kind === 'number') return card.value === top.value;
  if (top.kind !== 'number' && card.kind === top.kind) return true;
  return false;
}

export function playableCards(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return [];
  if (state.roundOver || state.window || state.awaitingColor) return [];
  if (state.drawChoice?.playerId === playerId) {
    return player.hand.filter(
      (card) => card.id === state.drawChoice.cardId && cardCanBePlayed(state, card),
    );
  }
  const playerIndex = state.players.indexOf(player);
  if (playerIndex !== state.currentIndex) return [];
  return player.hand.filter((card) => cardCanBePlayed(state, card));
}

function cardCanBePlayed(state, card) {
  if (state.pendingDraw) {
    if (!state.config.stackDraws) return false;
    if (state.pendingDraw.top === 'draw2') {
      return card.kind === 'draw2' || card.kind === 'wild4';
    }
    if (state.pendingDraw.top === 'wild4') {
      return card.kind === 'wild4' || (state.config.wild4FollowDraw2 && card.kind === 'draw2');
    }
    return false;
  }
  return isPlayableAgainstTop(state, card);
}

function isFollowPlayable(state, card, pendingCount) {
  if (card.kind === 'wild' || card.kind === 'wild4') return false;
  if (pendingCount > 0) return card.kind === 'draw2';
  return isPlayableAgainstTop(state, card);
}

function exactSnipeCards(state, player) {
  const top = state.discardPile[state.discardPile.length - 1];
  if (!top || top.kind === 'wild' || top.kind === 'wild4') return [];
  return player.hand.filter((card) => {
    if (card.kind !== top.kind || card.color !== top.color) return false;
    if (top.kind === 'number') return card.value === top.value;
    return true;
  });
}

function hasAnyExactSnipe(state) {
  if (!['exact', 'follow'].includes(state.config.sniping)) return false;
  const top = state.discardPile[state.discardPile.length - 1];
  if (!top || top.kind === 'wild' || top.kind === 'wild4') return false;
  return state.players.some((player) => player.hand.length > 0 && exactSnipeCards(state, player).length > 0);
}

function hasAnyExactSnipeExcept(state, excludedIds) {
  if (!['exact', 'follow'].includes(state.config.sniping)) return false;
  const top = state.discardPile[state.discardPile.length - 1];
  if (!top || top.kind === 'wild' || top.kind === 'wild4') return false;
  const excluded = new Set(excludedIds);
  return state.players.some(
    (player) => player.hand.length > 0 && !excluded.has(player.id) && exactSnipeCards(state, player).length > 0,
  );
}

function followableCards(state, player, pendingCount) {
  if (state.config.sniping !== 'follow') return [];
  return player.hand.filter((card) => isFollowPlayable(state, card, pendingCount));
}

function nextWindowId(state) {
  state.windowSerial = (state.windowSerial || 0) + 1;
  return `w${state.windowSerial}`;
}

function incrementEffects(effects, card) {
  if (card.kind === 'skip') effects.skip += 1;
  if (card.kind === 'reverse') effects.reverse += 1;
  if (card.kind === 'draw2') effects.draw2 += 1;
}

function markUnoAfterPlay(state, player, events, declaredUno = false) {
  player.unoCalled = false;
  player.unoExposed = false;
  if (player.hand.length === 1) {
    if (declaredUno) {
      player.unoCalled = true;
      addLog(state, `${player.name} 打出牌的同时喊出 UNO！`, 'uno');
      events.push({ type: 'uno-called', playerId: player.id, message: `${player.name} 打出牌的同时喊出 UNO！` });
    } else {
      player.unoExposed = true;
      addLog(state, `${player.name} 只剩 1 张牌，还没喊 UNO`, 'warn');
      events.push({ type: 'uno-exposed', playerId: player.id, message: `${player.name} 只剩 1 张牌！` });
    }
  }
  if (player.hand.length === 0) {
    player.finishedAt = state.finishers.length + 1;
    state.finishers.push(player.id);
    addLog(state, `${player.name} 打完了手牌！`, 'finish');
    events.push({ type: 'player-finished', playerId: player.id, message: `${player.name} 打完了手牌！` });
  }
}

function startNewVolley(state, card, actorIndex, rng, events, pendingBase = 0, pendingSkip = 0) {
  const actor = state.players[actorIndex];
  const volley = {
    lastPlayerId: actor.id,
    lastIndex: actorIndex,
    effects: { reverse: 0, skip: pendingSkip, draw2: 0 },
    pendingDrawCount: pendingBase,
    lastDrawKind: null,
    justSniped: false,
    snipeMode: true,
  };
  incrementEffects(volley.effects, card);
  if (card.kind === 'draw2') {
    volley.pendingDrawCount += 2;
    volley.lastDrawKind = 'draw2';
  }
  state.volley = volley;
  state.window = null;
  openSnipeWindowOrContinue(state, rng, events);
}

function openSnipeWindowOrContinue(state, rng, events) {
  const volley = state.volley;
  if (!volley) return;
  if (volley.snipeMode && hasAnyExactSnipe(state)) {
    const top = state.discardPile[state.discardPile.length - 1];
    state.window = {
      id: nextWindowId(state),
      kind: 'snipe',
      topCard: top,
      passed: [],
    };
    return;
  }
  afterNoMoreSnipes(state, rng, events);
}

function afterNoMoreSnipes(state, rng, events) {
  const volley = state.volley;
  if (!volley) return;
  if (volley.justSniped && state.config.sniping === 'follow') {
    const player = state.players.find((p) => p.id === volley.lastPlayerId);
    if (player && followableCards(state, player, volley.pendingDrawCount).length > 0) {
      const index = state.players.indexOf(player);
      state.window = {
        id: nextWindowId(state),
        kind: 'follow',
        playerId: player.id,
        playerIndex: index,
      };
      return;
    }
  }
  settleVolley(state, rng, events);
}

function applySettlementTurn(state) {
  const volley = state.volley;
  if (!volley) return null;
  if (volley.effects.reverse % 2 === 1) state.direction *= -1;
  let target = stepIndex(state, volley.lastIndex);
  if (target === null) return null;
  const pending = volley.pendingDrawCount;
  state.currentIndex = target;
  state.drawChoice = null;
  if (pending > 0) {
    state.pendingDraw = {
      count: pending,
      top: volley.lastDrawKind || 'draw2',
      skipAfter: volley.effects.skip,
      fromPlayerId: volley.lastPlayerId,
    };
    state.turnSerial += 1;
  } else {
    const afterSkips = volley.effects.skip > 0 ? skipIndexes(state, target, volley.effects.skip) : target;
    if (afterSkips === null) return null;
    state.currentIndex = afterSkips;
    state.pendingDraw = null;
    state.turnSerial += 1;
  }
  return state.currentIndex;
}

function closeVolley(state) {
  state.window = null;
  state.volley = null;
}

function finishRound(state, events) {
  if (state.roundOver) return;
  const winnerId = state.finishers[0];
  const winner = state.players.find((p) => p.id === winnerId);
  if (!winner) return;
  const cardPointsByPlayer = {};
  const scoreGained = {};
  for (const player of state.players) {
    const points = player.hand.length === 0 ? 0 : handPoints(player.hand);
    cardPointsByPlayer[player.id] = points;
    scoreGained[player.id] = points;
    player.score += points;
  }
  state.roundOver = true;
  state.phase = 'ROUND_END';
  state.window = null;
  state.volley = null;
  state.challenge = null;
  state.pendingDraw = null;
  state.drawChoice = null;
  state.currentIndex = null;
  state.roundResult = {
    winnerId,
    winnerName: winner.name,
    finishers: [...state.finishers],
    pointsGained: 0,
    scoreGained,
    cardPoints: cardPointsByPlayer,
    scores: Object.fromEntries(state.players.map((p) => [p.id, p.score])),
  };
  addLog(state, `${winner.name} 获得本局胜利，清空手牌得 0 分`, 'finish');
  events.push({
    type: 'round-end',
    message: `${winner.name} 获得本局胜利，清空手牌得 0 分`,
    winnerId,
    points: 0,
  });
}

function resolveEndEffects(state, rng, events) {
  if (state.finishers.length === 0) return false;
  const volley = state.volley;
  if (volley) {
    if (volley.effects.reverse % 2 === 1) state.direction *= -1;
    const targetIndex = stepIndex(state, volley.lastIndex);
    if (targetIndex !== null) {
      state.currentIndex = targetIndex;
      if (volley.pendingDrawCount > 0) {
        const target = state.players[targetIndex];
        const drawn = giveCards(state, target, volley.pendingDrawCount, rng);
        state.pendingDraw = null;
        if (drawn > 0) {
          addLog(state, `${target.name} 罚抽 ${drawn} 张`, 'draw');
          events.push({ type: 'penalty-draw', playerId: target.id, count: drawn, message: `${target.name} 罚抽 ${drawn} 张` });
        }
        if (volley.effects.skip > 0) {
          const next = skipIndexes(state, targetIndex, volley.effects.skip);
          if (next !== null) state.currentIndex = next;
        }
      } else if (volley.effects.skip > 0) {
        const next = skipIndexes(state, targetIndex, volley.effects.skip);
        if (next !== null) state.currentIndex = next;
      }
    }
  }
  closeVolley(state);
  state.pendingDraw = null;
  state.drawChoice = null;
  finishRound(state, events);
  return true;
}

function settleVolley(state, rng, events) {
  const volley = state.volley;
  if (!volley) return;
  if (state.finishers.length > 0) {
    resolveEndEffects(state, rng, events);
    return;
  }
  const target = applySettlementTurn(state);
  closeVolley(state);
  if (target === null) {
    const remaining = activePlayerCount(state);
    if (state.finishers.length > 0 || remaining === 0) {
      finishRound(state, events);
    }
  }
}

function setDrawChoice(state, player, card, options = {}) {
  const forceDraw = Boolean(options.forceDraw);
  state.drawChoice = {
    playerId: player.id,
    cardId: card?.id ?? null,
    canPlay: Boolean(card && cardCanBePlayed(state, card)),
    mustPlay: forceDraw || Boolean(options.mustPlay),
    forceDraw,
  };
}

function advanceTurnFrom(state, index) {
  const next = stepIndex(state, index);
  if (next === null) return null;
  state.currentIndex = next;
  state.turnSerial += 1;
  state.drawChoice = null;
  return next;
}

function maybeFinishAfterChallenge(state, events) {
  if (state.finishers.length > 0) {
    finishRound(state, events);
    return true;
  }
  return false;
}

function acceptWild4(state, rng, events) {
  const challenge = state.challenge;
  if (!challenge) return false;
  const challenger = state.players[challenge.challengerIndex];
  const count = state.pendingDraw?.count ?? 4;
  const drawn = giveCards(state, challenger, count, rng);
  state.challenge = null;
  state.pendingDraw = null;
  if (drawn > 0) {
    addLog(state, `${challenger.name} 接受罚抽 ${drawn} 张`, 'draw');
    events.push({ type: 'penalty-draw', playerId: challenger.id, count: drawn, message: `${challenger.name} 罚抽 ${drawn} 张` });
  }
  const next = advanceTurnFrom(state, challenge.challengerIndex);
  if (next === null || state.finishers.length > 0) {
    finishRound(state, events);
  }
  return true;
}

function hasColorMatch(player, color) {
  return Boolean(color) && player.hand.some((card) => card.color === color);
}

function challengeWild4(state, rng, events) {
  const challenge = state.challenge;
  const offender = state.players[challenge.offenderIndex];
  const challenger = state.players[challenge.challengerIndex];
  const guilty = Boolean(challenge.offenderHadColor);
  state.challenge = null;
  state.pendingDraw = null;
  if (guilty) {
    const drawn = giveCards(state, offender, 4, rng);
    addLog(state, `${challenger.name} 质疑成功，${offender.name} 罚抽 ${drawn} 张`, 'challenge');
    events.push({
      type: 'challenge-result',
      success: true,
      playerId: offender.id,
      message: `${challenger.name} 质疑成功，${offender.name} 罚抽 ${drawn} 张`,
    });
    state.currentIndex = challenge.challengerIndex;
    state.turnSerial += 1;
  } else {
    const drawn = giveCards(state, challenger, 6, rng);
    addLog(state, `${challenger.name} 质疑失败，罚抽 ${drawn} 张`, 'challenge');
    events.push({
      type: 'challenge-result',
      success: false,
      playerId: challenger.id,
      message: `${challenger.name} 质疑失败，罚抽 ${drawn} 张`,
    });
    advanceTurnFrom(state, challenge.challengerIndex);
  }
  maybeFinishAfterChallenge(state, events);
  return true;
}

function openChallengeForWild4(state, actorIndex, actor, events, previousColor) {
  const targetIndex = stepIndex(state, actorIndex);
  if (targetIndex === null) {
    finishRound(state, events);
    return;
  }
  state.currentIndex = targetIndex;
  state.pendingDraw = {
    count: 4,
    top: 'wild4',
    skipAfter: 0,
    fromPlayerId: actor.id,
  };
  state.challenge = {
    id: `c${++state.challengeSerial}`,
    challengerIndex: targetIndex,
    challengerId: state.players[targetIndex].id,
    offenderIndex: actorIndex,
    offenderId: actor.id,
    offenderHadColor: hasColorMatch(actor, previousColor),
  };
  state.turnSerial += 1;
  addLog(state, `${actor.name} 打出 Wild +4，等待${state.players[targetIndex].name}质疑或接受`, 'play');
}

function completeBasePlay(state, actorIndex, card, rng, events, options = {}) {
  const actor = state.players[actorIndex];
  markUnoAfterPlay(state, actor, events, Boolean(options.declaredUno));

  if (card.kind === 'wild') {
    if (state.finishers.length > 0) {
      finishRound(state, events);
      return;
    }
    const next = advanceTurnFrom(state, actorIndex);
    if (next === null) finishRound(state, events);
    return;
  }

  if (card.kind === 'wild4') {
    openChallengeForWild4(state, actorIndex, actor, events, options.previousActiveColor);
    return;
  }

  startNewVolley(state, card, actorIndex, rng, events);
}

function ensureTurnActor(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new GameError('NO_PLAYER', '玩家不存在');
  const index = state.players.indexOf(player);
  if (state.roundOver) throw new GameError('ROUND_OVER', '本局已经结束');
  return { player, index };
}

function ensureCurrent(state, playerId) {
  const actor = ensureTurnActor(state, playerId);
  if (actor.index !== state.currentIndex) throw new GameError('NOT_YOUR_TURN', '还没轮到你');
  return actor;
}

function ensureNormalTurnOpen(state) {
  if (state.window) throw new GameError('WINDOW_OPEN', '正在等待抢出结算');
  if (state.awaitingColor) throw new GameError('COLOR_OPEN', '请先选择颜色');
}

function validatePlayState(state) {
  const top = state.discardPile[state.discardPile.length - 1];
  if (state.pendingDraw && !state.config.stackDraws) {
    throw new GameError('MUST_DRAW', '当前必须罚抽，不能出牌');
  }
  if (!top) throw new GameError('NO_TOP', '牌堆状态异常');
}

function findCard(player, cardId) {
  const card = player.hand.find((c) => c.id === cardId);
  if (!card) throw new GameError('CARD_NOT_IN_HAND', '这张牌不在你的手中');
  return card;
}

function removeCard(player, card) {
  const index = player.hand.findIndex((c) => c.id === card.id);
  player.hand.splice(index, 1);
}

function publicPlayEvent(state, card, player, events, suffix = '') {
  const name = cardLabel(card);
  addLog(state, player ? `${player.name} 打出 ${name}${suffix}` : `打出 ${name}${suffix}`, 'play');
  events.push({
    type: 'card-played',
    playerId: player?.id ?? null,
    card: publicCard(card),
    message: player ? `${player.name} 打出 ${name}${suffix}` : `打出 ${name}${suffix}`,
  });
}

function publicCard(card) {
  return { ...card };
}

export function cardLabel(card) {
  if (!card) return '无';
  const colorNames = { red: '红', yellow: '黄', green: '绿', blue: '蓝' };
  if (card.kind === 'number') return `${colorNames[card.color]}${card.value}`;
  if (card.kind === 'skip') return `${colorNames[card.color]} Skip`;
  if (card.kind === 'reverse') return `${colorNames[card.color]} Reverse`;
  if (card.kind === 'draw2') return `${colorNames[card.color]} +2`;
  if (card.kind === 'wild') return 'Wild';
  return 'Wild +4';
}

function playCardAction(state, action, rng, events) {
  const { player, index } = ensureCurrent(state, action.playerId);
  ensureNormalTurnOpen(state);
  validatePlayState(state);
  const card = findCard(player, action.cardId);
  if (state.drawChoice?.playerId === player.id) {
    if (state.drawChoice.cardId !== card.id) {
      throw new GameError('ONLY_DRAWN_CARD', '抽牌后只能打出刚抽到的牌');
    }
    if (!state.drawChoice.canPlay) throw new GameError('CARD_NOT_PLAYABLE', '刚抽到的牌不能打出');
  } else if (!cardCanBePlayed(state, card)) {
    throw new GameError('CARD_NOT_PLAYABLE', '这张牌不能出');
  }

  let chosenColor = null;
  if (card.kind === 'wild' || card.kind === 'wild4') {
    assertColor(action.chosenColor);
    chosenColor = action.chosenColor;
  }

  const wasStack = Boolean(state.pendingDraw);
  const priorPending = wasStack ? { ...state.pendingDraw } : null;
  const previousActiveColor = state.activeColor;
  const declaredUno = action.callUno === true;
  removeCard(player, card);
  state.drawChoice = null;
  state.discardPile.push(card);
  state.activeColor = card.color ?? chosenColor;
  state.challenge = null;
  publicPlayEvent(state, card, player, events, chosenColor ? `（${colorName(chosenColor)}）` : '');

  if (wasStack) {
    state.pendingDraw = null;
    const skipAfter = priorPending?.skipAfter ?? 0;
    if (card.kind === 'wild4') {
      const count = (priorPending?.count ?? 0) + 4;
      state.pendingDraw = { count, top: 'wild4', skipAfter, fromPlayerId: player.id };
      const next = stepIndex(state, index);
      markUnoAfterPlay(state, player, events, declaredUno);
      if (next === null) {
        finishRound(state, events);
        return;
      }
      state.currentIndex = next;
      state.turnSerial += 1;
      if (state.finishers.length > 0) {
        const target = state.players[next];
        const drawn = giveCards(state, target, count, rng);
        state.pendingDraw = null;
        if (drawn > 0) {
          addLog(state, `${target.name} 罚抽 ${drawn} 张`, 'draw');
          events.push({ type: 'penalty-draw', playerId: target.id, count: drawn, message: `${target.name} 罚抽 ${drawn} 张` });
        }
        finishRound(state, events);
      }
      return;
    }
    if (card.kind === 'draw2') {
      markUnoAfterPlay(state, player, events, declaredUno);
      startNewVolley(state, card, index, rng, events, priorPending?.count ?? 0, skipAfter);
      return;
    }
    throw new GameError('CARD_NOT_PLAYABLE', '当前只能叠加罚抽牌');
  }

  completeBasePlay(state, index, card, rng, events, { declaredUno, previousActiveColor });
}

function drawCardAction(state, action, rng, events) {
  const { player, index } = ensureCurrent(state, action.playerId);
  if (state.window) throw new GameError('WINDOW_OPEN', '正在等待抢出结算');
  if (state.awaitingColor) throw new GameError('COLOR_OPEN', '请先选择颜色');

  if (state.challenge) {
    if (state.challenge.challengerIndex !== index) throw new GameError('NOT_CHALLENGER', '当前不是质疑者');
    acceptWild4(state, rng, events);
    return;
  }

  if (state.pendingDraw) {
    const count = state.pendingDraw.count;
    const skipAfter = state.pendingDraw.skipAfter || 0;
    const drawn = giveCards(state, player, count, rng);
    state.pendingDraw = null;
    state.drawChoice = null;
    addLog(state, `${player.name} 罚抽 ${drawn} 张`, 'draw');
    events.push({ type: 'penalty-draw', playerId: player.id, count: drawn, message: `${player.name} 罚抽 ${drawn} 张` });
    const next = stepIndex(state, index);
    if (next === null) {
      finishRound(state, events);
      return;
    }
    const finalIndex = skipAfter > 0 ? skipIndexes(state, next, skipAfter) : next;
    if (finalIndex === null) {
      finishRound(state, events);
      return;
    }
    state.currentIndex = finalIndex;
    state.turnSerial += 1;
    return;
  }

  const continuingForcedDraw = Boolean(
    state.drawChoice
      && state.drawChoice.playerId === player.id
      && state.drawChoice.forceDraw,
  );
  if (state.drawChoice && !continuingForcedDraw) {
    throw new GameError('ALREADY_DREW', '本回合已经抽过牌');
  }

  const forceDraw = continuingForcedDraw || Boolean(state.config.forceDrawUntilPlayable);
  const card = drawOne(state, rng);
  if (!card) {
    addLog(state, `${player.name} 抽牌，但牌堆已空`, 'draw');
    events.push({ type: 'drew', playerId: player.id, count: 0, message: `${player.name} 抽牌，但牌堆已空` });
    state.drawChoice = null;
    const next = advanceTurnFrom(state, index);
    if (next === null) finishRound(state, events);
    return;
  }

  player.hand.push(card);
  if (player.hand.length > 1) {
    player.unoCalled = false;
    player.unoExposed = false;
  }
  addLog(state, `${player.name} 抽了 1 张牌`, 'draw');
  events.push({ type: 'drew', playerId: player.id, count: 1, message: `${player.name} 抽了 1 张牌` });

  const playableDrawn = cardCanBePlayed(state, card);
  if (forceDraw) {
    setDrawChoice(state, player, card, { forceDraw: true });
    return;
  }
  if (playableDrawn) {
    setDrawChoice(state, player, card);
  } else {
    const next = advanceTurnFrom(state, index);
    if (next === null) finishRound(state, events);
  }
}

function endTurnAction(state, action, events) {
  const { player, index } = ensureCurrent(state, action.playerId);
  if (state.window || state.challenge || state.awaitingColor) throw new GameError('NOT_READY', '当前不能结束回合');
  if (!state.drawChoice || state.drawChoice.playerId !== player.id) {
    throw new GameError('NO_DRAW_CHOICE', '只有抽牌后才能选择结束回合');
  }
  if (state.drawChoice.forceDraw) {
    throw new GameError('MUST_DRAW_OR_PLAY', '抽到能出为止：请继续抽牌，或打出一张可出的牌');
  }
  if (state.drawChoice.mustPlay) throw new GameError('MUST_PLAY', '必须打出抽到的牌');
  state.drawChoice = null;
  const next = advanceTurnFrom(state, index);
  addLog(state, `${player.name} 结束回合`, 'info');
  events.push({ type: 'end-turn', playerId: player.id, message: `${player.name} 结束回合` });
  if (next === null) finishRound(state, events);
}

function callUnoAction(state, action, events) {
  const player = state.players.find((p) => p.id === action.playerId);
  if (!player) throw new GameError('NO_PLAYER', '玩家不存在');
  if (state.roundOver) throw new GameError('ROUND_OVER', '本局已经结束');
  if (player.hand.length !== 1) {
    throw new GameError('UNO_NOT_ALLOWED', '只有剩 1 张牌时才能喊 UNO');
  }
  player.unoCalled = true;
  player.unoExposed = false;
  addLog(state, `${player.name} 喊出 UNO！`, 'uno');
  events.push({ type: 'uno-called', playerId: player.id, message: `${player.name} 喊出 UNO！` });
}

function catchUnoAction(state, action, rng, events) {
  const caller = state.players.find((p) => p.id === action.playerId);
  const target = state.players.find((p) => p.id === action.targetId);
  if (!caller || !target) throw new GameError('NO_PLAYER', '玩家不存在');
  if (caller.id === target.id) throw new GameError('CANNOT_CATCH_SELF', '不能抓自己');
  if (!target.unoExposed || target.unoCalled || target.hand.length !== 1) {
    throw new GameError('UNO_SAFE', '对方已经安全，不能抓 UNO');
  }
  if (state.roundOver) throw new GameError('ROUND_OVER', '本局已经结束');
  target.unoExposed = false;
  target.unoCalled = false;
  const drawn = giveCards(state, target, 2, rng);
  addLog(state, `${caller.name} 抓到 ${target.name} 没喊 UNO，罚抽 ${drawn} 张`, 'uno');
  events.push({
    type: 'uno-caught',
    playerId: caller.id,
    targetId: target.id,
    count: drawn,
    message: `${caller.name} 抓到 ${target.name} 没喊 UNO，罚抽 ${drawn} 张`,
  });
}

function challengeAction(state, action, rng, events) {
  const { index } = ensureCurrent(state, action.playerId);
  if (state.window) throw new GameError('WINDOW_OPEN', '正在等待抢出结算');
  if (!state.challenge) throw new GameError('NO_CHALLENGE', '当前没有可质疑的 Wild Draw Four');
  if (state.challenge.challengerIndex !== index) throw new GameError('NOT_CHALLENGER', '只有被罚玩家可以质疑');
  challengeWild4(state, rng, events);
}

function chooseColorAction(state, action, events) {
  const color = action.color;
  assertColor(color);
  if (state.awaitingColor) {
    if (state.awaitingColor.playerId !== action.playerId) throw new GameError('NOT_COLOR_CHOOSER', '还没轮到你选色');
    state.awaitingColor = null;
    state.activeColor = color;
    addLog(state, `${state.players[state.currentIndex].name} 选择了${colorName(color)}`, 'color');
    events.push({ type: 'color-chosen', color, message: `首张 Wild：选择${colorName(color)}` });
    return;
  }
  throw new GameError('NO_COLOR_CHOICE', '当前不需要选择颜色');
}

function snipeAction(state, action, rng, events) {
  if (!state.window || state.window.kind !== 'snipe') throw new GameError('NO_SNIPE_WINDOW', '当前不能抢出');
  const player = state.players.find((p) => p.id === action.playerId);
  if (!player) throw new GameError('NO_PLAYER', '玩家不存在');
  if (state.window.passed?.includes(player.id)) {
    throw new GameError('SNIPE_PASSED', '你已经放弃本次抢出');
  }
  const matches = exactSnipeCards(state, player);
  const card = matches.find((c) => c.id === action.cardId);
  if (!card) throw new GameError('CARD_NOT_MATCH', '这张牌不能抢出');
  const index = state.players.indexOf(player);
  removeCard(player, card);
  state.drawChoice = null;
  state.discardPile.push(card);
  state.activeColor = card.color ?? state.activeColor;
  incrementEffects(state.volley.effects, card);
  if (card.kind === 'draw2') {
    state.volley.pendingDrawCount += 2;
    state.volley.lastDrawKind = 'draw2';
  }
  state.volley.lastPlayerId = player.id;
  state.volley.lastIndex = index;
  state.volley.justSniped = true;
  state.volley.snipeMode = true;
  publicPlayEvent(state, card, player, events, '（抢出）');
  markUnoAfterPlay(state, player, events, action.callUno === true);
  openSnipeWindowOrContinue(state, rng, events);
}

function passSnipeAction(state, action, rng, events) {
  if (!state.window || state.window.kind !== 'snipe') {
    throw new GameError('NO_SNIPE_WINDOW', '当前没有抢出窗口');
  }
  if (action.windowId && action.windowId !== state.window.id) {
    throw new GameError('STALE_WINDOW', '抢出窗口已经结束');
  }
  const player = state.players.find((p) => p.id === action.playerId);
  if (!player) throw new GameError('NO_PLAYER', '玩家不存在');
  state.window.passed ??= [];
  if (state.window.passed.includes(player.id)) {
    throw new GameError('SNIPE_PASSED', '你已经放弃本次抢出');
  }
  if (exactSnipeCards(state, player).length === 0) {
    throw new GameError('CARD_NOT_MATCH', '你没有可以抢出的同名牌');
  }
  state.window.passed.push(player.id);
  if (!hasAnyExactSnipeExcept(state, state.window.passed)) {
    state.window = null;
    afterNoMoreSnipes(state, rng, events);
  }
}

function followAction(state, action, rng, events) {
  if (!state.window || state.window.kind !== 'follow') throw new GameError('NO_FOLLOW_WINDOW', '当前不能跟牌');
  if (state.window.playerId !== action.playerId) throw new GameError('NOT_FOLLOW_ACTOR', '还没轮到你跟牌');
  const player = state.players.find((p) => p.id === action.playerId);
  if (!player) throw new GameError('NO_PLAYER', '玩家不存在');
  if (!action.cardId) {
    state.window = null;
    state.volley.justSniped = false;
    settleVolley(state, rng, events);
    return;
  }
  const card = findCard(player, action.cardId);
  if (!isFollowPlayable(state, card, state.volley.pendingDrawCount)) {
    throw new GameError('CARD_NOT_FOLLOWABLE', '这张牌不能跟出');
  }
  const index = state.players.indexOf(player);
  removeCard(player, card);
  state.drawChoice = null;
  state.discardPile.push(card);
  state.activeColor = card.color ?? state.activeColor;
  incrementEffects(state.volley.effects, card);
  if (card.kind === 'draw2') {
    state.volley.pendingDrawCount += 2;
    state.volley.lastDrawKind = 'draw2';
  }
  state.volley.lastPlayerId = player.id;
  state.volley.lastIndex = index;
  state.volley.justSniped = false;
  state.volley.snipeMode = true;
  state.window = null;
  publicPlayEvent(state, card, player, events, '（跟出）');
  markUnoAfterPlay(state, player, events, action.callUno === true);
  openSnipeWindowOrContinue(state, rng, events);
}

function timeoutWindowAction(state, action, rng, events) {
  if (!state.window) return;
  if (action.windowId && action.windowId !== state.window.id) return;
  if (state.window.kind === 'snipe') {
    state.window = null;
    afterNoMoreSnipes(state, rng, events);
    return;
  }
  if (state.window.kind === 'follow') {
    state.window = null;
    state.volley.justSniped = false;
    settleVolley(state, rng, events);
  }
}

function timeoutChallengeAction(state, action, rng, events) {
  if (!state.challenge) return;
  if (action.challengeId && action.challengeId !== state.challenge.id) return;
  acceptWild4(state, rng, events);
}

function timeoutTurnAction(state, action, rng, events) {
  if (state.roundOver) return;
  if (state.window || state.awaitingColor) return;
  if (state.currentIndex === null) return;
  const player = state.players[state.currentIndex];
  if (!player) return;
  if (state.challenge) {
    if (state.challenge.challengerId === player.id) acceptWild4(state, rng, events);
    return;
  }
  if (state.drawChoice?.playerId === player.id) {
    state.drawChoice = null;
    advanceTurnFrom(state, state.currentIndex);
    addLog(state, `${player.name} 超时，跳过回合`, 'warn');
    events.push({ type: 'turn-timeout', playerId: player.id, message: `${player.name} 超时，跳过回合` });
    if (state.finishers.length > 0) finishRound(state, events);
    return;
  }
  if (state.pendingDraw) {
    const count = state.pendingDraw.count;
    const skipAfter = state.pendingDraw.skipAfter || 0;
    const drawn = giveCards(state, player, count, rng);
    state.pendingDraw = null;
    addLog(state, `${player.name} 超时，罚抽 ${drawn} 张并跳过回合`, 'warn');
    events.push({ type: 'turn-timeout', playerId: player.id, message: `${player.name} 超时，罚抽 ${drawn} 张` });
    const next = stepIndex(state, state.currentIndex);
    if (next === null) {
      finishRound(state, events);
      return;
    }
    const finalIndex = skipAfter > 0 ? skipIndexes(state, next, skipAfter) : next;
    if (finalIndex === null) {
      finishRound(state, events);
      return;
    }
    state.currentIndex = finalIndex;
    state.turnSerial += 1;
    return;
  }
  addLog(state, `${player.name} 超时，跳过回合`, 'warn');
  events.push({ type: 'turn-timeout', playerId: player.id, message: `${player.name} 超时，跳过回合` });
  const next = advanceTurnFrom(state, state.currentIndex);
  if (next === null) finishRound(state, events);
}

export function applyAction(previousState, action, rng = defaultRng) {
  const state = clone(previousState);
  const events = [];
  if (!action || typeof action.type !== 'string') throw new GameError('BAD_ACTION', '无效操作');
  if (state.roundOver && !['getView'].includes(action.type)) {
    throw new GameError('ROUND_OVER', '本局已经结束');
  }
  state.seq = (state.seq || 0) + 1;

  switch (action.type) {
    case 'playCard':
      playCardAction(state, action, rng, events);
      break;
    case 'drawCard':
      drawCardAction(state, action, rng, events);
      break;
    case 'endTurn':
      endTurnAction(state, action, events);
      break;
    case 'callUno':
      callUnoAction(state, action, events);
      break;
    case 'catchUno':
      catchUnoAction(state, action, rng, events);
      break;
    case 'chooseColor':
      chooseColorAction(state, action, events);
      break;
    case 'challenge':
      challengeAction(state, action, rng, events);
      break;
    case 'snipe':
      snipeAction(state, action, rng, events);
      break;
    case 'passSnipe':
      passSnipeAction(state, action, rng, events);
      break;
    case 'follow':
      followAction(state, action, rng, events);
      break;
    case 'timeoutWindow':
      timeoutWindowAction(state, action, rng, events);
      break;
    case 'timeoutChallenge':
      timeoutChallengeAction(state, action, rng, events);
      break;
    case 'timeoutTurn':
      timeoutTurnAction(state, action, rng, events);
      break;
    default:
      throw new GameError('UNKNOWN_ACTION', '未知操作');
  }
  return { state, events };
}

function initialTurnSetup(state, rng, events) {
  const players = state.players;
  const top = state.discardPile[state.discardPile.length - 1];
  state.currentIndex = 0;
  state.activeColor = top.color;
  if (top.kind === 'wild') {
    state.activeColor = null;
    state.awaitingColor = { playerId: players[0].id };
    addLog(state, '首张为 Wild，由首位玩家选择颜色', 'info');
    events.push({ type: 'initial-wild', message: '首张为 Wild，请首位玩家选择颜色' });
    return;
  }
  if (top.kind === 'skip') {
    const next = stepIndex(state, 0);
    state.currentIndex = next ?? 0;
    addLog(state, `${players[0].name} 被首张 Skip 跳过`, 'effect');
    events.push({ type: 'initial-effect', message: `${players[0].name} 被首张 Skip 跳过` });
    return;
  }
  if (top.kind === 'reverse') {
    state.direction = -1;
    const next = stepIndex(state, 0);
    state.currentIndex = next ?? 0;
    addLog(state, '首张 Reverse 改变了方向', 'effect');
    events.push({ type: 'initial-effect', message: '首张 Reverse 改变了方向' });
    return;
  }
  if (top.kind === 'draw2') {
    const victim = players[0];
    const drawn = giveCards(state, victim, 2, rng);
    addLog(state, `${victim.name} 被首张 +2 罚抽 ${drawn} 张`, 'effect');
    events.push({ type: 'initial-effect', message: `${victim.name} 被首张 +2 罚抽 ${drawn} 张` });
    const next = stepIndex(state, 0);
    state.currentIndex = next ?? 0;
  }
}

export function startRound({ players, config = {}, roundNumber = 1, rng = defaultRng }) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 10) {
    throw new GameError('BAD_PLAYERS', '游戏需要 2–10 名玩家');
  }
  const normalizedConfig = { ...DEFAULT_CONFIG, ...config };
  if (!['off', 'exact', 'follow'].includes(normalizedConfig.sniping)) normalizedConfig.sniping = 'exact';
  const deck = shuffle(buildDeck(), rng);
  const gamePlayers = players.map((p) => ({
    id: p.id,
    name: p.name,
    isBot: Boolean(p.isBot),
    score: Number(p.score) || 0,
    hand: [],
    unoCalled: false,
    unoExposed: false,
    finishedAt: null,
  }));
  for (const player of gamePlayers) {
    for (let i = 0; i < 7; i += 1) player.hand.push(deck.pop());
  }
  let firstCard;
  do {
    firstCard = deck.pop();
    if (firstCard?.kind === 'wild4') {
      deck.unshift(firstCard);
      const reshuffled = shuffle(deck, rng);
      deck.length = 0;
      deck.push(...reshuffled);
      firstCard = null;
    }
  } while (!firstCard);
  const state = {
    seq: 0,
    logSeq: 0,
    windowSerial: 0,
    challengeSerial: 0,
    roundNumber,
    config: normalizedConfig,
    players: gamePlayers,
    drawPile: deck,
    discardPile: [firstCard],
    activeColor: firstCard.color,
    direction: 1,
    currentIndex: 0,
    turnSerial: 0,
    pendingDraw: null,
    drawChoice: null,
    challenge: null,
    awaitingColor: null,
    window: null,
    volley: null,
    finishers: [],
    roundOver: false,
    phase: 'PLAYING',
    log: [],
    roundResult: null,
  };
  const events = [];
  initialTurnSetup(state, rng, events);
  return { state, events };
}

export function getPlayerView(state, viewerId) {
  if (!state) return null;
  const viewer = state.players.find((p) => p.id === viewerId);
  const currentPlayer = state.currentIndex === null ? null : state.players[state.currentIndex];
  const top = state.discardPile[state.discardPile.length - 1] ?? null;
  const view = {
    seq: state.seq,
    roundNumber: state.roundNumber,
    config: state.config,
    direction: state.direction,
    activeColor: state.activeColor,
    currentPlayerId: currentPlayer?.id ?? null,
    currentPlayerIndex: state.currentIndex,
    topCard: top,
    drawPileCount: state.drawPile.length,
    discardCount: state.discardPile.length,
    pendingDraw: state.pendingDraw
      ? { count: state.pendingDraw.count, top: state.pendingDraw.top }
      : null,
    challenge: state.challenge
      ? {
          id: state.challenge.id,
          challengerId: state.challenge.challengerId,
          offenderId: state.challenge.offenderId,
          count: state.pendingDraw?.count ?? 4,
          isChallenger: viewer?.id === state.challenge.challengerId,
        }
      : null,
    unoExposed: state.players.filter((p) => p.unoExposed && !p.unoCalled).map((p) => p.id),
    drawChoice: state.drawChoice
      ? {
          playerId: state.drawChoice.playerId,
          mustPlay: state.drawChoice.mustPlay,
          forceDraw: Boolean(state.drawChoice.forceDraw),
          isYou: state.drawChoice.playerId === viewerId,
          cardId: state.drawChoice.playerId === viewerId ? state.drawChoice.cardId : null,
        }
      : null,
    finishers: [...state.finishers],
    roundOver: state.roundOver,
    roundResult: state.roundResult,
    awaitingColor: state.awaitingColor
      ? { playerId: state.awaitingColor.playerId, isYou: state.awaitingColor.playerId === viewerId }
      : null,
    players: state.players.map((p, index) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      seat: index,
      handCount: p.hand.length,
      score: p.score,
      finished: p.hand.length === 0,
      uno: p.unoCalled,
      unoExposed: p.unoExposed && !p.unoCalled,
      isCurrent: index === state.currentIndex,
    })),
    yourHand: viewer ? viewer.hand.map((card) => ({ ...card })) : [],
    playableCardIds: playableCards(state, viewerId).map((card) => card.id),
    isYourTurn: Boolean(viewer && state.currentIndex !== null && state.currentIndex === state.players.indexOf(viewer)),
    window: null,
    log: state.log.slice(-14),
  };
  if (state.window?.kind === 'snipe') {
    const passed = Boolean(viewer && state.window.passed?.includes(viewer.id));
    const yourMatches = viewer && !passed ? exactSnipeCards(state, viewer).map((c) => c.id) : [];
    view.window = {
      id: state.window.id,
      kind: 'snipe',
      topCard: state.window.topCard,
      eligibleCardIds: yourMatches,
      canSnipe: yourMatches.length > 0,
      passed,
    };
  } else if (state.window?.kind === 'follow') {
    const isActor = viewer?.id === state.window.playerId;
    const actor = state.players.find((p) => p.id === state.window.playerId);
    const eligible = isActor ? followableCards(state, actor, state.volley?.pendingDrawCount ?? 0).map((c) => c.id) : [];
    view.window = {
      id: state.window.id,
      kind: 'follow',
      playerId: state.window.playerId,
      isYou: isActor,
      eligibleCardIds: isActor ? eligible : [],
    };
  }
  return view;
}

export function colorName(color) {
  return { red: '红色', yellow: '黄色', green: '绿色', blue: '蓝色' }[color] ?? color;
}

export { cardPoints };
