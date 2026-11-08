const socket = io();
const $ = (id) => document.getElementById(id);
const COLORS = ['red', 'yellow', 'green', 'blue'];
const COLOR_NAMES = { red: '红色', yellow: '黄色', green: '绿色', blue: '蓝色' };
const COLOR_HEX = { red: '#d8352a', yellow: '#e1a90d', green: '#2f9c54', blue: '#2867ba' };
const COLOR_SHORT = { red: '红', yellow: '黄', green: '绿', blue: '蓝' };
const CARD_LABELS = { skip: 'Skip', reverse: 'Reverse', draw2: 'Draw Two', wild: 'Wild', wild4: 'Wild Draw Four' };
const HAND_COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3 };
const HAND_KIND_ORDER = { number: 0, skip: 1, reverse: 2, draw2: 3, wild: 4, wild4: 5 };
const WILD_REVEAL_MS = 500;

const ui = {
  room: null,
  game: null,
  meId: null,
  currentCode: null,
  token: null,
  screen: 'home',
  serverOffset: 0,
  connected: socket.connected,
  loadingDepth: 0,
  rejoining: false,
  intentionalLeave: false,
  sessionReplaced: false,
  colorContext: null,
  pendingWildCardId: null,
  lastGameActionAt: 0,
  lastToastKey: '',
  lastToastAt: 0,
  lastHandIds: new Set(),
  lastTopCardId: null,
  lastDiscardRoundKey: null,
  wildReveal: null,
  actionBusy: false,
  localUnoPending: false,
  roundMinimized: false,
  matchMinimized: false,
  lobbyRooms: [],
  lobbyLoaded: false,
  lobbyLoading: false,
  lobbyError: false,
};

const screens = {
  home: $('home-screen'),
  room: $('room-screen'),
  game: $('game-screen'),
};

let handResizeObserver = null;
let handLayoutSeq = 0;
let forcedDrawTimer = null;
let roundRevealTimer = null;
let roundRevealKey = null;
let roundRevealReadyKey = null;

const initialParams = new URLSearchParams(window.location.search);
const initialRoomCode = (initialParams.get('room') || '').toUpperCase();

function tokenKey(code) {
  return `uno.token.${code}`;
}

function savedToken(code) {
  try {
    return localStorage.getItem(tokenKey(code));
  } catch {
    return null;
  }
}

function saveToken(code, token) {
  try {
    localStorage.setItem(tokenKey(code), token);
  } catch {
    /* storage can be unavailable in private modes */
  }
}

function removeToken(code) {
  try {
    localStorage.removeItem(tokenKey(code));
  } catch {
    /* ignore */
  }
}

function setUrlRoom(code) {
  try {
    const url = new URL(window.location.href);
    if (code) url.searchParams.set('room', code);
    else url.searchParams.delete('room');
    window.history.replaceState(null, '', url);
  } catch {
    /* ignore */
  }
}

const NICKNAME_STORAGE_KEY = 'uno.nickname';

function saveNickname(name) {
  try {
    localStorage.setItem(NICKNAME_STORAGE_KEY, name);
  } catch {
    /* ignore */
  }
}

function removeSavedNickname() {
  try {
    localStorage.removeItem(NICKNAME_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = text;
  return element;
}

function initialOf(name) {
  const clean = String(name || '?').trim();
  return clean ? clean.slice(0, 1).toUpperCase() : '?';
}

function avatarStyle(id, name) {
  let hash = 0;
  const source = String(id || name || '');
  for (let i = 0; i < source.length; i += 1) hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `--av-a:hsl(${hue} 48% 62%);--av-b:hsl(${(hue + 38) % 360} 41% 35%)`;
}

function cardLabel(card) {
  if (!card) return '';
  if (card.kind === 'number') return `${COLOR_SHORT[card.color]}${card.value}`;
  if (card.kind === 'wild') return 'Wild';
  if (card.kind === 'wild4') return 'Wild Draw Four';
  return `${COLOR_SHORT[card.color]} ${CARD_LABELS[card.kind]}`;
}

function showToast(message, kind = 'info', options = {}) {
  const now = Date.now();
  const key = `${kind}:${message}`;
  if (ui.lastToastKey === key && now - ui.lastToastAt < 800) return;
  ui.lastToastAt = now;
  ui.lastToastKey = key;

  const stack = $('toasts');
  const toast = node('div', `toast ${kind}`, message);
  stack.appendChild(toast);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  const duration = options.duration ?? (kind === 'error' ? 3800 : 2700);
  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 260);
  }, duration);
}

function clearToasts() {
  $('toasts').innerHTML = '';
  ui.lastToastKey = '';
}

function pushLoading(text) {
  ui.loadingDepth += 1;
  $('loading-text').textContent = text || '正在处理…';
  $('loading-overlay').hidden = false;
}

function popLoading() {
  ui.loadingDepth = Math.max(0, ui.loadingDepth - 1);
  if (ui.loadingDepth === 0) $('loading-overlay').hidden = true;
}

function setNetworkState(mode) {
  const labels = {
    online: '已连接',
    offline: '连接中断',
    connecting: '重新连接中',
  };
  const cls = mode === 'online' ? '' : mode === 'offline' ? 'offline' : 'connecting';
  for (const el of [$('net-status'),$('game-net-status')]) {
    if (!el) continue;
    el.className = `net-status${el.id === 'game-net-status' ? ' compact' : ''} ${cls}`.trim();
    el.replaceChildren(node('i', 'net-dot'), document.createTextNode(labels[mode]));
  }
  ui.connected = mode === 'online';
}

function setConnectionOverlay(visible, title = '连接中断', text = '正在尝试重新连接服务器…') {
  $('connection-title').textContent = title;
  $('connection-text').textContent = text;
  $('connection-overlay').hidden = !visible;
  $('connection-home').hidden = !visible;
}

function showScreen(name) {
  ui.screen = name;
  for (const [key, element] of Object.entries(screens)) {
    element.hidden = key !== name;
  }
  if (name === 'home') {
    renderPublicRooms();
    if (socket.connected && !ui.lobbyLoaded && !ui.lobbyLoading) {
      refreshLobbyList({ silent: true });
    }
  }
}

function isMyTurn() {
  return Boolean(ui.game && !ui.game.roundOver && ui.game.currentPlayerId === ui.meId);
}

function canDeclareUnoLocally() {
  const game = ui.game;
  if (!game || game.roundOver || game.awaitingColor) return false;
  const me = game.players.find((player) => player.id === ui.meId);
  if (!me || me.handCount !== 2 || me.uno) return false;
  if (game.currentPlayerId === ui.meId && !game.window) {
    return (game.playableCardIds || []).length > 0;
  }
  if (game.window?.kind === 'snipe' && game.window.canSnipe) return true;
  return Boolean(
    game.window?.kind === 'follow'
      && game.window.isYou
      && (game.window.eligibleCardIds || []).length > 0,
  );
}

function syncLocalUno() {
  if (ui.localUnoPending && !canDeclareUnoLocally()) ui.localUnoPending = false;
}

function withLocalUno(payload = {}) {
  return ui.localUnoPending ? { ...payload, callUno: true } : payload;
}

function myGamePlayer() {
  return ui.game?.players.find((player) => player.id === ui.meId) ?? null;
}

function myRoomPlayer() {
  return ui.room?.players.find((player) => player.id === ui.meId) ?? null;
}

function isHost() {
  return Boolean(ui.room && ui.room.hostId === ui.meId);
}

function playerName(id) {
  return ui.game?.players.find((player) => player.id === id)?.name
    ?? ui.room?.players.find((player) => player.id === id)?.name
    ?? '玩家';
}

function currentPlayerName() {
  return ui.game?.currentPlayerId ? playerName(ui.game.currentPlayerId) : '—';
}

function request(event, payload = {}) {
  return new Promise((resolve) => {
    if (!socket.connected) {
      resolve({ ok: false, code: 'OFFLINE', message: '尚未连接到服务器' });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, code: 'TIMEOUT', message: '请求超时，请检查网络后重试' });
    }, 10000);
    socket.emit(event, payload, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response ?? { ok: false, code: 'NO_REPLY', message: '服务器没有响应' });
    });
  });
}

async function requestWithError(event, payload = {}) {
  const response = await request(event, payload);
  if (!response?.ok) {
    showToast(response?.message || '操作失败', 'error');
  }
  return response;
}

function clearForcedDrawTimer() {
  if (forcedDrawTimer) {
    clearTimeout(forcedDrawTimer);
    forcedDrawTimer = null;
  }
}

function clearWildReveal() {
  if (ui.wildReveal?.timer) clearTimeout(ui.wildReveal.timer);
  ui.wildReveal = null;
}

async function gameAction(event, payload = {}) {
  clearForcedDrawTimer();
  const now = Date.now();
  if (now - ui.lastGameActionAt < 260) return null;
  ui.lastGameActionAt = now;
  if (!['game:playCard', 'game:snipe', 'game:follow'].includes(event)) {
    ui.localUnoPending = false;
  }
  const response = await request(event, payload);
  if (!response?.ok) {
    showToast(response?.message || '操作失败', 'error');
    return null;
  }
  return response;
}

function clearSessionState({ goHome = true } = {}) {
  clearForcedDrawTimer();
  if (ui.currentCode) removeToken(ui.currentCode);
  ui.token = null;
  ui.currentCode = null;
  ui.room = null;
  ui.game = null;
  ui.meId = null;
  ui.pendingWildCardId = null;
  ui.colorContext = null;
  ui.localUnoPending = false;
  ui.lastHandIds = new Set();
  hideOverlaysForNoGame();
  setUrlRoom(null);
  if (goHome) showScreen('home');
}

function hideOverlaysForNoGame() {
  $('round-end-overlay').hidden = true;
  $('match-end-overlay').hidden = true;
  $('color-modal').hidden = true;
  $('settlement-restore').hidden = true;
  resetRoundReveal();
  ui.matchMinimized = false;
  ui.pendingWildCardId = null;
  ui.colorContext = null;
  ui.localUnoPending = false;
  clearWildReveal();
}

function applySession(code, playerId, token) {
  if (code) {
    ui.currentCode = code;
    setUrlRoom(code);
  }
  if (playerId) ui.meId = playerId;
  if (token) {
    ui.token = token;
    saveToken(code, token);
  }
  ui.intentionalLeave = false;
  ui.sessionReplaced = false;
}

function applyRoom(room) {
  const previousPhase = ui.room?.phase;
  ui.room = room;
  if (!ui.meId && room.youId) ui.meId = room.youId;
  if (room.code) {
    ui.currentCode = room.code;
    setUrlRoom(room.code);
  }
  if (!ui.token && ui.currentCode) {
    const stored = savedToken(ui.currentCode);
    if (stored) ui.token = stored;
  }
  if (room.phase === 'LOBBY') {
    ui.game = null;
    ui.pendingWildCardId = null;
    ui.colorContext = null;
    hideOverlaysForNoGame();
  }
  if (previousPhase && previousPhase !== room.phase && room.phase === 'LOBBY') {
    clearToasts();
  }
  if (previousPhase !== room.phase) {
    if (room.phase === 'GAME_END' || room.phase === 'ROUND_END') {
      ui.actionBusy = false;
    }
  }
  routeScreen();
  if (ui.screen === 'room') renderRoom();
  if (ui.screen === 'game') {
    renderGameToolbar();
    renderRoundOverlay();
    renderMatchOverlay();
  }
}

function routeScreen() {
  if (!ui.room) {
    showScreen('home');
    return;
  }
  const inGame = Boolean(ui.game && ui.game.players.some((player) => player.id === ui.meId));
  if (ui.room.phase === 'PLAYING') {
    showScreen(inGame ? 'game' : 'room');
    return;
  }
  if (ui.room.phase === 'ROUND_END' || ui.room.phase === 'GAME_END') {
    showScreen(inGame && ui.game ? 'game' : 'room');
    return;
  }
  if (ui.room.phase === 'DEALING') {
    showScreen(ui.game ? 'game' : 'room');
    return;
  }
  showScreen('room');
}

function applyGame(game) {
  ui.game = game;
  syncLocalUno();
  if (typeof game.serverNow === 'number') {
    ui.serverOffset = game.serverNow - Date.now();
  }
  routeScreen();
  if (ui.screen === 'game') {
    renderGame();
    syncColorModal();
    scheduleForcedAutoDraw();
  }
  if (ui.screen === 'room') renderRoom();
}

/* ---------------- Home ---------------- */

const nameInput = $('home-name');
const joinCodeInput = $('join-code');
try {
  nameInput.value = (localStorage.getItem(NICKNAME_STORAGE_KEY) || '').slice(0, 16);
} catch {
  /* ignore */
}
if (initialRoomCode) joinCodeInput.value = initialRoomCode;

function persistNickname() {
  const name = nameInput.value.trim();
  if (name) saveNickname(name);
  else removeSavedNickname();
}

nameInput.addEventListener('input', persistNickname);
nameInput.addEventListener('change', persistNickname);

$('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (ui.actionBusy) return;
  const name = nameInput.value.trim();
  if (!name) {
    showToast('请先输入昵称', 'warn');
    nameInput.focus();
    return;
  }
  saveNickname(name);
  ui.actionBusy = true;
  $('create-btn').disabled = true;
  pushLoading('正在创建牌桌…');
  const response = await request('room:create', {
    name,
    isPublic: $('create-public').checked,
  });
  popLoading();
  $('create-btn').disabled = false;
  ui.actionBusy = false;
  if (!response?.ok) {
    showToast(response?.message || '创建房间失败', 'error');
    return;
  }
  applySession(response.code, response.playerId, response.token);
  if (response.room) applyRoom(response.room);
});

async function joinRoomByCode(rawCode) {
  if (ui.actionBusy) return;
  const name = nameInput.value.trim();
  const code = String(rawCode ?? '').trim().toUpperCase();
  if (!name) {
    showToast('请先输入昵称', 'warn');
    nameInput.focus();
    return;
  }
  if (!/^[A-Z0-9]{4,6}$/.test(code)) {
    showToast('请输入正确的房间码', 'warn');
    joinCodeInput.focus();
    return;
  }
  joinCodeInput.value = code;
  saveNickname(name);
  ui.actionBusy = true;
  $('join-btn').disabled = true;
  pushLoading('正在加入牌桌…');
  const response = await request('room:join', { code, name });
  popLoading();
  $('join-btn').disabled = false;
  ui.actionBusy = false;
  if (!response?.ok) {
    showToast(response?.message || '加入房间失败', 'error');
    if (ui.screen === 'home') refreshLobbyList({ silent: true });
    return;
  }
  applySession(response.code, response.playerId, response.token);
  if (response.room) applyRoom(response.room);
}

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  joinRoomByCode(joinCodeInput.value);
});

$('join-code').addEventListener('input', (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
});

/* ---------------- Public lobby ---------------- */

function publicRoomPhaseMeta(phase) {
  if (phase === 'PLAYING') return { className: 'playing', label: '对局中' };
  if (phase === 'ROUND_END') return { className: 'between', label: '局间休息' };
  if (phase === 'DEALING') return { className: 'playing', label: '发牌中' };
  return { className: 'open', label: '等待开局' };
}

function setLobbyRooms(rooms) {
  if (!Array.isArray(rooms)) return;
  ui.lobbyRooms = rooms;
  ui.lobbyLoaded = true;
  ui.lobbyError = false;
  if (ui.screen === 'home') renderPublicRooms();
}

async function refreshLobbyList({ silent = true } = {}) {
  if (!socket.connected || ui.lobbyLoading) return;
  ui.lobbyLoading = true;
  ui.lobbyError = false;
  const button = $('refresh-lobby');
  if (button) button.disabled = true;
  if (ui.screen === 'home') renderPublicRooms();
  const response = await request('lobby:list', {});
  ui.lobbyLoading = false;
  if (button) button.disabled = false;
  if (response?.ok) {
    setLobbyRooms(response.rooms);
  } else {
    ui.lobbyError = true;
    if (!silent) showToast(response?.message || '公开牌桌刷新失败', 'error');
  }
  if (ui.screen === 'home') renderPublicRooms();
}

function renderPublicRooms() {
  const list = $('public-rooms');
  if (!list) return;
  const count = $('public-room-count');
  if (count) count.textContent = ui.lobbyLoaded ? `${ui.lobbyRooms.length} 桌` : '—';
  if (!ui.lobbyLoaded) {
    list.innerHTML = '';
    const message = ui.lobbyLoading
      ? '正在读取公开牌桌…'
      : ui.lobbyError
        ? '暂时无法读取公开牌桌，请点击刷新。'
        : '连接服务器后显示公开牌桌。';
    list.appendChild(node('div', 'lobby-empty', message));
    return;
  }
  list.innerHTML = '';
  if (ui.lobbyRooms.length === 0) {
    list.appendChild(node('div', 'lobby-empty', '暂无公开牌桌。创建房间并勾选「公开房间」，即可出现在这里。'));
    return;
  }
  for (const room of ui.lobbyRooms) {
    const card = node('div', 'public-room');
    const avatar = node('div', 'pub-avatar', initialOf(room.hostName));
    avatar.style.cssText = avatarStyle(room.code, room.hostName);
    card.appendChild(avatar);

    const main = node('div', 'pub-main');
    const title = node('div', 'pub-title');
    title.append(node('strong', '', room.hostName || '房主'));
    const phase = publicRoomPhaseMeta(room.phase);
    title.append(node('span', `pub-status ${phase.className}`, phase.label));
    main.appendChild(title);

    const meta = node('div', 'pub-meta');
    meta.append(node('span', '', `${room.playerCount}/${room.maxPlayers} 人`));
    meta.append(node('span', 'pub-divider'));
    meta.append(node('span', 'pub-code', `房间 ${room.code}`));
    if (room.config?.stackDraws) meta.append(node('span', 'pub-tag', '叠加罚抽'));
    if (room.config?.sniping && room.config.sniping !== 'off') {
      meta.append(node('span', 'pub-tag', room.config.sniping === 'follow' ? '抢出+跟牌' : '抢出'));
    }
    if (room.config?.forceDrawUntilPlayable) meta.append(node('span', 'pub-tag', '抽到能出'));
    main.appendChild(meta);
    card.appendChild(main);

    let label = '加入';
    if (room.phase === 'PLAYING') label = '对局中';
    else if (room.playerCount >= room.maxPlayers) label = '已满';
    else if (!room.joinable) label = '暂不可加入';
    const join = node('button', `win-btn tiny pub-join${room.joinable ? '' : ' is-blocked'}`, label);
    join.type = 'button';
    join.disabled = !room.joinable;
    join.title = room.joinable ? `加入 ${room.hostName} 的牌桌` : phase.label;
    if (room.joinable) {
      join.addEventListener('click', async () => {
        if (ui.actionBusy) return;
        join.disabled = true;
        await joinRoomByCode(room.code);
        if (ui.screen === 'home') renderPublicRooms();
      });
    }
    card.appendChild(join);
    list.appendChild(card);
  }
}

$('refresh-lobby').addEventListener('click', () => refreshLobbyList({ silent: false }));

/* ---------------- Room ---------------- */

function phaseText(phase) {
  return {
    LOBBY: '等待玩家入座',
    DEALING: '正在发牌',
    PLAYING: '对局进行中',
    ROUND_END: '本局结束 · 等待下一局',
    GAME_END: '整场比赛已结束',
  }[phase] || '房间';
}

function renderRoom() {
  const room = ui.room;
  if (!room) return;
  $('room-code-display').textContent = room.code;
  $('room-phase-label').textContent = phaseText(room.phase);
  $('room-player-count').textContent = `${room.players.length} / ${room.maxPlayers || 10}`;
  renderRoomPlayers(room);
  renderRules(room);
  renderRoomActions(room);
  renderRoomVisibility(room);
}

function renderRoomVisibility(room) {
  const badge = $('room-visibility');
  const toggle = $('toggle-visibility');
  if (!badge || !toggle) return;
  const isPublic = Boolean(room.isPublic);
  badge.textContent = isPublic ? '公开房间' : '私人房间';
  badge.classList.toggle('public', isPublic);
  badge.classList.toggle('private', !isPublic);
  const canToggle = isHost() && ['LOBBY', 'ROUND_END'].includes(room.phase);
  toggle.hidden = !canToggle;
  toggle.disabled = !canToggle;
  toggle.textContent = isPublic ? '设为私人' : '公开到大厅';
}

function renderRoomPlayers(room) {
  const list = $('room-players');
  list.innerHTML = '';
  for (const player of room.players) {
    const card = node('div', `room-player${player.isHost ? ' is-host' : ''}${player.connected ? '' : ' offline'}`);
    const avatar = node('div', 'p-avatar', player.isBot ? 'BOT' : initialOf(player.name));
    avatar.style.cssText = avatarStyle(player.id, player.name);
    card.appendChild(avatar);

    const main = node('div', 'p-main');
    const nameLine = node('div', 'p-name');
    nameLine.append(node('span', '', player.name));
    if (player.isHost) nameLine.append(node('span', 'tag host', '房主'));
    if (player.isBot) nameLine.append(node('span', 'tag bot', '电脑'));
    main.appendChild(nameLine);
    const sub = node('div', 'p-sub');
    sub.append(node('span', 'p-score', `${player.score} 分`));
    if (!player.connected && !player.isBot) sub.append(node('span', 'tag offline', '离线'));
    if (player.isBot) sub.append(node('span', 'tag ready', '已就绪'));
    else if (player.ready) sub.append(node('span', 'tag ready', '已准备'));
    else sub.append(node('span', 'tag not-ready', '未准备'));
    main.appendChild(sub);
    card.appendChild(main);

    if (isHost() && player.isBot && ['LOBBY', 'ROUND_END'].includes(room.phase)) {
      const actions = node('div', 'p-actions');
      const remove = node('button', 'p-remove', '移除');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        const response = await requestWithError('room:removeBot', { botId: player.id });
        if (response?.ok) showToast('已移除机器人');
      });
      actions.appendChild(remove);
      card.appendChild(actions);
    }
    list.appendChild(card);
  }
}

function renderRules(room) {
  const canEdit = isHost() && ['LOBBY', 'ROUND_END'].includes(room.phase);
  const config = room.config;
  $('config-stack').checked = Boolean(config.stackDraws);
  $('config-wild4-draw2').checked = Boolean(config.wild4FollowDraw2);
  $('config-force').checked = Boolean(config.forceDrawUntilPlayable);
  $('config-sniping').value = config.sniping || 'exact';
  for (const control of [$('config-stack'), $('config-wild4-draw2'), $('config-force'), $('config-sniping')]) {
    control.disabled = !canEdit;
  }
  if (!config.stackDraws) $('config-wild4-draw2').disabled = true;
  $('wild4-draw2-row').classList.toggle('disabled', !config.stackDraws || !canEdit);
  $('rules-list').parentElement.classList.toggle('is-locked', !canEdit);
  $('host-only-note').hidden = isHost();
}

function readConfigControls() {
  return {
    stackDraws: $('config-stack').checked,
    wild4FollowDraw2: $('config-wild4-draw2').checked,
    forceDrawUntilPlayable: $('config-force').checked,
    sniping: $('config-sniping').value,
  };
}

for (const id of ['config-stack', 'config-wild4-draw2', 'config-force', 'config-sniping']) {
  $(id).addEventListener('change', async () => {
    if (!isHost()) return;
    if (!['LOBBY', 'ROUND_END'].includes(ui.room?.phase)) return;
    const config = readConfigControls();
    const response = await requestWithError('room:updateConfig', { config });
    if (response?.ok) showToast('桌面规则已更新');
    else if (ui.room) renderRules(ui.room);
  });
}

function renderRoomActions(room) {
  const host = isHost();
  const canManage = ['LOBBY', 'ROUND_END'].includes(room.phase);
  const me = myRoomPlayer();
  const readyButton = $('room-ready');
  readyButton.hidden = host;
  readyButton.disabled = !canManage || room.phase === 'GAME_END';
  readyButton.textContent = me?.ready ? '取消准备' : '准备';
  readyButton.classList.toggle('primary', !me?.ready);

  const addBot = $('add-bot');
  addBot.hidden = !host;
  addBot.disabled = !canManage || room.players.length >= (room.maxPlayers || 10);

  const start = $('room-start');
  start.hidden = !host;
  start.disabled = !room.canStart || ui.actionBusy;
  start.textContent = room.phase === 'ROUND_END' ? '开始下一局' : '开始游戏';

  const hint = $('start-hint');
  if (!host) {
    hint.textContent = '等待房主开始游戏';
  } else if (room.players.length < 2) {
    hint.textContent = '至少需要 2 人';
  } else {
    const unready = room.players.filter((player) => !player.isBot && player.connected && !player.ready);
    hint.textContent = unready.length ? `${unready.length} 人尚未准备` : '全员已准备';
  }
}

$('toggle-visibility').addEventListener('click', async () => {
  if (!isHost() || ui.actionBusy || !ui.room) return;
  const button = $('toggle-visibility');
  const nextPublic = !ui.room.isPublic;
  button.disabled = true;
  const response = await requestWithError('room:setVisibility', { isPublic: nextPublic });
  if (response?.ok) {
    ui.room.isPublic = Boolean(response.isPublic);
    renderRoomVisibility(ui.room);
    showToast(response.isPublic ? '房间已公开，将出现在游戏大厅' : '房间已设为私人');
  } else if (ui.room) {
    renderRoomVisibility(ui.room);
  }
});

$('room-ready').addEventListener('click', async () => {
  const me = myRoomPlayer();
  if (!me) return;
  $('room-ready').disabled = true;
  const response = await requestWithError('room:ready', { ready: !me.ready });
  if (!response?.ok) $('room-ready').disabled = false;
});

$('add-bot').addEventListener('click', async () => {
  const button = $('add-bot');
  if (button.disabled) return;
  button.disabled = true;
  const response = await requestWithError('room:addBot', {});
  if (response?.ok) showToast('机器人已入座');
  else if (ui.room) renderRoomActions(ui.room);
});

$('room-start').addEventListener('click', startNextRound);
$('next-round-btn').addEventListener('click', startNextRound);

async function startNextRound() {
  if (ui.actionBusy) return;
  ui.actionBusy = true;
  $('room-start').disabled = true;
  $('next-round-btn').disabled = true;
  const response = await request('room:start', {});
  ui.actionBusy = false;
  $('next-round-btn').disabled = false;
  if (!response?.ok) {
    showToast(response?.message || '无法开始对局', 'error');
    if (ui.screen === 'room') renderRoomActions(ui.room);
    else renderRoundOverlay();
    return;
  }
  $('round-end-overlay').hidden = true;
}

$('end-match-btn').addEventListener('click', async () => {
  if (!window.confirm('结束整场比赛并锁定最终排名？')) return;
  await requestWithError('room:endMatch', {});
});

$('new-match-btn').addEventListener('click', async () => {
  await requestWithError('room:newMatch', {});
});

$('room-leave').addEventListener('click', leaveRoom);
$('game-leave').addEventListener('click', leaveRoom);
$('round-leave-btn').addEventListener('click', leaveRoom);
$('match-leave-btn').addEventListener('click', leaveRoom);

$('brand-home').addEventListener('click', (event) => {
  if (!ui.room) return;
  event.preventDefault();
  leaveRoom();
});

$('copy-invite').addEventListener('click', copyInvite);
$('game-copy').addEventListener('click', copyInvite);

async function leaveRoom() {
  if (!ui.room) {
    clearSessionState();
    return;
  }
  if (['PLAYING', 'ROUND_END'].includes(ui.room.phase)) {
    const message = ui.room.phase === 'PLAYING'
      ? '对局尚未结束，离开后你的座位会由电脑接管。确定离开吗？'
      : '确定离开这个房间吗？';
    if (!window.confirm(message)) return;
  }
  ui.intentionalLeave = true;
  clearForcedDrawTimer();
  const code = ui.currentCode;
  const response = await request('room:leave', {});
  if (!response?.ok && socket.connected) {
    ui.intentionalLeave = false;
    showToast(response?.message || '离开房间失败', 'error');
    return;
  }
  if (code) removeToken(code);
  ui.token = null;
  ui.currentCode = null;
  ui.room = null;
  ui.game = null;
  ui.meId = null;
  ui.intentionalLeave = false;
  ui.sessionReplaced = false;
  hideOverlaysForNoGame();
  setConnectionOverlay(false);
  setUrlRoom(null);
  showScreen('home');
  if (socket.connected) refreshLobbyList({ silent: true });
}

async function copyInvite() {
  const code = ui.room?.code || ui.currentCode;
  if (!code) return;
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('room', code);
  try {
    await navigator.clipboard.writeText(url.toString());
    showToast('邀请链接已复制');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = url.toString();
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      showToast('邀请链接已复制');
    } catch {
      showToast(`请手动复制房间码：${code}`, 'warn');
    }
    textarea.remove();
  }
}

/* ---------------- Cards ---------------- */

const SVG_ICONS = {
  skip: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="19" fill="none" stroke="currentColor" stroke-width="7"/><line x1="18" y1="46" x2="46" y2="18" stroke="currentColor" stroke-width="7"/></svg>',
  reverse: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 27h23l-7-7" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M46 39H23l7 7" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  draw2: '<svg viewBox="0 0 48 38" aria-hidden="true"><rect x="4" y="5" width="23" height="29" rx="4" fill="none" stroke="currentColor" stroke-width="4" transform="rotate(-9 15 19)"/><rect x="19" y="3" width="23" height="29" rx="4" fill="none" stroke="currentColor" stroke-width="4" transform="rotate(8 30 17)"/></svg>',
};

function cardShort(card) {
  if (card.kind === 'number') return String(card.value);
  if (card.kind === 'skip') return 'S';
  if (card.kind === 'reverse') return 'R';
  if (card.kind === 'draw2') return '+2';
  if (card.kind === 'wild') return 'W';
  return '+4';
}

function makeCard(card, options = {}) {
  const element = node('div', 'card');
  if (card.color) element.classList.add(`color-${card.color}`);
  if (card.kind === 'wild' || card.kind === 'wild4') element.classList.add('wild-card');
  if (options.extraClass) element.classList.add(...options.extraClass.split(' ').filter(Boolean));
  element.dataset.cardId = card.id;
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', cardLabel(card));

  const short = cardShort(card);
  const top = node('span', `card-corner top${card.kind === 'number' ? '' : ' action-corner'}`, short);
  const bottom = node('span', `card-corner bottom${card.kind === 'number' ? '' : ' action-corner'}`, short);
  element.append(top, bottom);

  const center = node('div', 'card-center');
  if (card.kind === 'number') {
    center.append(node('span', 'card-number', String(card.value)));
  } else if (card.kind === 'skip' || card.kind === 'reverse') {
    const symbol = node('span', 'card-symbol');
    symbol.innerHTML = SVG_ICONS[card.kind];
    center.appendChild(symbol);
  } else if (card.kind === 'draw2') {
    const symbol = node('div', 'draw2-symbol');
    const icon = node('span');
    icon.innerHTML = SVG_ICONS.draw2;
    symbol.append(icon, node('b', '', '+2'));
    center.appendChild(symbol);
  } else if (card.kind === 'wild') {
    center.classList.add('wild-center');
    center.append(node('span', 'wild-wheel'), node('span', 'wild-label', 'WILD'));
  } else {
    center.classList.add('wild-center', 'wild4-center');
    center.append(node('span', 'wild-wheel'), node('span', 'wild-label wild4-label', '+4'));
  }
  element.appendChild(center);
  return element;
}

function makeCardBack() {
  return node('div', 'card-back');
}

/* ---------------- Game rendering ---------------- */

function renderGame() {
  if (!ui.game) return;
  renderGameToolbar();
  renderOpponents();
  renderTableCenter();
  renderSelf();
  renderHand();
  renderActions();
  renderBanner();
  //renderLog();
  renderRoundOverlay();
  renderMatchOverlay();
}

function renderGameToolbar() {
  if (!ui.room) return;
  $('game-code').textContent = ui.room.code;
  $('game-round').textContent = String(ui.game?.roundNumber ?? ui.room.roundNumber ?? 1);
  const me = myGamePlayer() ?? myRoomPlayer();
  $('game-score').textContent = String(me?.score ?? 0);
}

function renderOpponents() {
  const container = $('opponents');
  container.innerHTML = '';
  const game = ui.game;
  if (!game) return;
  const players = [...game.players].sort((a, b) => a.seat - b.seat);
  const myIndex = players.findIndex((player) => player.id === ui.meId);
  const ordered =
    myIndex >= 0
      ? [...players.slice(myIndex + 1), ...players.slice(0, myIndex)]
      : players;
  const opponents = ordered.filter((player) => player.id !== ui.meId);
  if (opponents.length === 0) {
    const empty = node('div', 'opponent');
    empty.append(node('span', 'op-name', '暂无对手'));
    container.appendChild(empty);
    return;
  }
  for (const player of opponents) {
    const chip = node('div', 'opponent');
    if (player.isCurrent && !game.roundOver) chip.classList.add('current');
    if (!player.connected) chip.classList.add('disconnected');
    const avatar = node('div', 'op-avatar', player.isBot ? 'BOT' : initialOf(player.name));
    avatar.style.cssText = avatarStyle(player.id, player.name);
    chip.appendChild(avatar);

    const main = node('div', 'op-main');
    const nameLine = node('div', 'op-name-line');
    nameLine.append(node('span', 'op-name', player.name));
    if (player.isCurrent && !game.roundOver) {
      const marker = node('span', 'current-marker');
      marker.title = '当前回合';
      chip.appendChild(marker);
    }
    main.appendChild(nameLine);

    const tags = node('div', 'op-tags');
    if (player.isHost) tags.append(node('span', 'tag op-tag host', '房主'));
    if (player.isBot) tags.append(node('span', 'tag op-tag bot', '电脑'));
    if (!player.connected) tags.append(node('span', 'tag op-tag offline', '离线'));
    if (player.uno) tags.append(node('span', 'uno-pill', 'UNO'));
    main.appendChild(tags);

    const handLine = node('div', 'op-hand');
    const mini = node('div', 'mini-stack');
    mini.append(node('i'), node('i'), node('i'));
    handLine.append(mini, node('span', 'op-count', String(player.handCount)));
    main.appendChild(handLine);
    chip.appendChild(main);

    if (player.unoExposed && !game.roundOver) {
      const catchButton = node('button', 'catch-uno', '抓 UNO');
      catchButton.type = 'button';
      catchButton.title = `抓 ${player.name} 没喊 UNO`;
      catchButton.addEventListener('click', (event) => {
        event.stopPropagation();
        gameAction('game:catchUno', { targetId: player.id });
      });
      chip.appendChild(catchButton);
    }
    container.appendChild(chip);
  }
}

function renderTableCenter() {
  const game = ui.game;
  const me = myGamePlayer();
  $('draw-count').textContent = String(game.drawPileCount);
  $('game-banner').classList.remove('urgent');

  const colorDot = $('active-color-dot');
  const color = game.activeColor || null;
  colorDot.style.setProperty('--active-color', color ? COLOR_HEX[color] : '#8b9a94');
  $('active-color-name').textContent = color ? COLOR_NAMES[color] : '待选择';

  const arrow = $('direction-arrow');
  arrow.classList.toggle('reverse', game.direction === -1);
  $('direction-name').textContent = game.direction === -1 ? '逆时针' : '顺时针';

  const stackCount = game.pendingDraw?.count ?? 0;
  const stackCard = $('draw-stack-card');
  $('draw-stack-count').textContent = String(stackCount);
  stackCard.classList.toggle('active', stackCount > 0);

  const pending = $('pending-badge');
  if (stackCount > 0) {
    pending.hidden = false;
    pending.textContent = `罚抽 +${game.pendingDraw.count}`;
  } else {
    pending.hidden = true;
  }

  const discard = $('discard-pile');
  discard.innerHTML = '';
  const discardRoundKey = `${ui.room?.code ?? ''}:${game.roundNumber ?? ''}`;
  if (ui.lastDiscardRoundKey !== discardRoundKey) {
    ui.lastDiscardRoundKey = discardRoundKey;
    ui.lastTopCardId = null;
    clearWildReveal();
  }
  const topCardId = game.topCard?.id ?? null;
  const topCardChanged = Boolean(topCardId && ui.lastTopCardId && topCardId !== ui.lastTopCardId);
  if (game.topCard) {
    const cardElement = makeCard(game.topCard);
    if (topCardChanged) cardElement.classList.add('played-anim');
    const isWild = game.topCard.kind === 'wild' || game.topCard.kind === 'wild4';
    if (isWild && game.activeColor) {
      cardElement.style.setProperty('--wild-color', COLOR_HEX[game.activeColor] || '#20262b');
      let reveal = ui.wildReveal;
      if (!reveal || reveal.cardId !== topCardId) {
        clearWildReveal();
        const delay = topCardChanged ? WILD_REVEAL_MS : 0;
        reveal = { cardId: topCardId, revealAt: Date.now() + delay, timer: null };
        ui.wildReveal = reveal;
        if (delay > 0) {
          reveal.timer = setTimeout(() => {
            if (ui.wildReveal !== reveal) return;
            reveal.timer = null;
            const current = discard.querySelector('.card');
            if (current?.dataset.cardId === reveal.cardId) {
              current.classList.add('wild-colored');
            }
          }, delay);
        }
      }
      if (Date.now() >= reveal.revealAt) cardElement.classList.add('wild-colored');
    } else {
      clearWildReveal();
    }
    discard.appendChild(cardElement);
  } else {
    clearWildReveal();
    discard.appendChild(node('span', 'empty-pile', '等待发牌'));
  }
  ui.lastTopCardId = topCardId;

  const canDraw = canDrawNow();
  $('draw-pile').classList.toggle('can-draw', canDraw);
  $('draw-pile').setAttribute('aria-disabled', canDraw ? 'false' : 'true');

  if (stackCount > 0) {
    $('pending-badge').setAttribute('aria-label', `当前累计罚抽 ${stackCount} 张`);
  }
  if (me?.unoExposed) {
    // The action bar will surface the urgent declaration button.
  }
}

function canDrawNow() {
  const game = ui.game;
  if (!game || game.roundOver || !isMyTurn()) return false;
  if (game.window || game.awaitingColor) return false;
  if (game.drawChoice) {
    return Boolean(game.drawChoice.isYou && game.drawChoice.forceDraw);
  }
  return true;
}

function renderSelf() {
  const me = myGamePlayer();
  const roomMe = myRoomPlayer();
  const fallback = me || roomMe;
  $('self-name').textContent = fallback?.name ?? '你';
  $('self-score').textContent = String(fallback?.score ?? 0);
  const avatar = $('self-avatar');
  avatar.textContent = me?.isBot ? 'BOT' : initialOf(fallback?.name ?? '你');
  avatar.style.cssText = avatarStyle(ui.meId, fallback?.name);
  document.querySelector('.self-panel')?.classList.toggle('current-turn', isMyTurn());
  const uno = $('self-uno');
  if (me?.uno || me?.unoExposed) {
    uno.hidden = false;
    uno.textContent = me.uno ? 'UNO' : '未喊 UNO';
    uno.style.background = me.uno
      ? 'linear-gradient(180deg, #f15f51, #c72c20)'
      : 'linear-gradient(180deg, #ffbe55, #c87a14)';
  } else {
    uno.hidden = true;
  }
}

function sortHandForDisplay(hand) {
  return [...hand].sort((a, b) => {
    const colorA = a.color ? HAND_COLOR_ORDER[a.color] : 4;
    const colorB = b.color ? HAND_COLOR_ORDER[b.color] : 4;
    if (colorA !== colorB) return colorA - colorB;
    const kindA = HAND_KIND_ORDER[a.kind] ?? 99;
    const kindB = HAND_KIND_ORDER[b.kind] ?? 99;
    if (kindA !== kindB) return kindA - kindB;
    if (a.kind === 'number' && b.kind === 'number' && a.value !== b.value) {
      return a.value - b.value;
    }
    return String(a.id).localeCompare(String(b.id), 'en');
  });
}

function numericStyle(style, name) {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

function layoutHand() {
  if (ui.screen !== 'game') return;
  const hand = $('hand');
  const scroller = $('hand-scroller');
  if (!hand || !scroller) return;
  const cards = [...hand.querySelectorAll('.card')];
  if (cards.length === 0) return;
  const cardWidth = cards[0].getBoundingClientRect().width;
  if (!cardWidth) return;
  const scrollerStyle = getComputedStyle(scroller);
  const handStyle = getComputedStyle(hand);
  const available = Math.max(
    0,
    scroller.clientWidth
      - numericStyle(scrollerStyle, 'padding-left')
      - numericStyle(scrollerStyle, 'padding-right')
      - numericStyle(handStyle, 'padding-left')
      - numericStyle(handStyle, 'padding-right')
      - 4,
  );
  if (available <= 0) return;

  const count = cards.length;
  const normalGap = cardWidth < 80 ? 5 : 8;
  const normalWidth = count * cardWidth + (count - 1) * normalGap;
  let gaps = [];
  let stacked = false;

  if (count > 1) {
    if (normalWidth <= available) {
      gaps = Array.from({ length: count - 1 }, () => cardWidth + normalGap);
    } else {
      stacked = true;
      const gapCount = count - 1;
      const minExposure = Math.max(22, Math.round(cardWidth * 0.3));
      const exposure = Math.max(minExposure, (available - cardWidth) / gapCount);
      gaps = Array.from({ length: gapCount }, () => exposure);
    }
  }

  cards.forEach((card, index) => {
    card.style.zIndex = String(index + 1);
    if (index === 0) {
      card.style.marginLeft = '0px';
    } else {
      const exposure = gaps[index - 1] ?? cardWidth;
      card.style.marginLeft = `${exposure - cardWidth}px`;
    }
  });
  hand.classList.toggle('stacked', stacked);
}

function centerHandCard(cardId) {
  const game = ui.game;
  if (!game?.drawChoice?.isYou || game.drawChoice.cardId !== cardId) return;
  const scroller = $('hand-scroller');
  if (!scroller || scroller.scrollWidth <= scroller.clientWidth + 1) return;
  const card = [...$('hand').querySelectorAll('.card')].find((item) => item.dataset.cardId === cardId);
  if (!card) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const delta = cardRect.left - scrollerRect.left - (scroller.clientWidth - cardRect.width) / 2;
  scroller.scrollTo({
    left: Math.max(0, scroller.scrollLeft + delta),
    behavior: 'auto',
  });
}

function scheduleHandLayout(focusCardId = null) {
  const sequence = ++handLayoutSeq;
  requestAnimationFrame(() => {
    if (sequence !== handLayoutSeq) return;
    layoutHand();
    if (focusCardId) {
      requestAnimationFrame(() => {
        if (sequence !== handLayoutSeq) return;
        centerHandCard(focusCardId);
      });
    }
    // The first frame can precede the surrounding panel's final reflow.
    setTimeout(() => {
      if (sequence !== handLayoutSeq) return;
      layoutHand();
      if (focusCardId) centerHandCard(focusCardId);
    }, 160);
  });
}

function setupHandLayoutObserver() {
  if (handResizeObserver) return;
  if (typeof ResizeObserver === 'function') {
    handResizeObserver = new ResizeObserver(() => {
      if (ui.screen === 'game') layoutHand();
    });
    handResizeObserver.observe($('hand-scroller'));
  } else {
    window.addEventListener('resize', () => {
      if (ui.screen === 'game') layoutHand();
    });
  }
}

function scheduleForcedAutoDraw() {
  clearForcedDrawTimer();
  const game = ui.game;
  if (!game || game.roundOver || ui.screen !== 'game') return;
  const choice = game.drawChoice;
  if (!choice?.isYou || !choice.forceDraw) return;
  if (game.window || game.challenge || game.awaitingColor) return;
  if ((game.playableCardIds || []).includes(choice.cardId)) return;
  if (!socket.connected) return;
  const sequence = game.seq;
  forcedDrawTimer = setTimeout(() => {
    forcedDrawTimer = null;
    const current = ui.game;
    if (!current || current.seq !== sequence || current.roundOver) return;
    const currentChoice = current.drawChoice;
    if (!currentChoice?.isYou || !currentChoice.forceDraw) return;
    if ((current.playableCardIds || []).includes(currentChoice.cardId)) return;
    if (!socket.connected) return;
    gameAction('game:drawCard', {});
  }, 650);
}

function renderHand() {
  const game = ui.game;
  const hand = $('hand');
  hand.innerHTML = '';
  if (!game) return;
  const myHand = sortHandForDisplay(game.yourHand || []);
  const playable = new Set(game.playableCardIds || []);
  const snipeable = new Set(game.window?.kind === 'snipe' ? game.window.eligibleCardIds || [] : []);
  const followable = new Set(
    game.window?.kind === 'follow' && game.window.isYou ? game.window.eligibleCardIds || [] : [],
  );
  const currentIds = new Set();

  if (myHand.length === 0) {
    hand.appendChild(node('div', 'empty-hand', game.roundOver ? '你已出完手牌' : '手牌已空'));
    return;
  }

  for (const card of myHand) {
    currentIds.add(card.id);
    const extra = ['hand-card'];
    if (snipeable.has(card.id)) extra.push('snipeable', 'playable');
    else if (followable.has(card.id)) extra.push('followable', 'playable');
    else if (playable.has(card.id)) extra.push('playable');
    else extra.push('not-playable');
    if (game.drawChoice?.isYou && game.drawChoice.cardId === card.id) extra.push('just-drawn');
    if (!ui.lastHandIds.has(card.id)) extra.push('dealt');
    const element = makeCard(card, { extraClass: extra.join(' ') });
    element.dataset.action = 'hand-card';
    if (snipeable.has(card.id)) element.title = '点击抢出这张同名牌';
    else if (followable.has(card.id)) element.title = '点击跟出这张牌';
    else if (playable.has(card.id)) element.title = '点击打出这张牌';
    element.addEventListener('click', () => onHandCardClick(card, playable, snipeable, followable));
    hand.appendChild(element);
  }
  ui.lastHandIds = currentIds;
  scheduleHandLayout(game.drawChoice?.isYou ? game.drawChoice.cardId : null);
}

function onHandCardClick(card, playable, snipeable, followable) {
  if (!ui.game || ui.game.roundOver) return;
  if (snipeable.has(card.id)) {
    gameAction('game:snipe', withLocalUno({ cardId: card.id }));
    return;
  }
  if (followable.has(card.id)) {
    gameAction('game:follow', withLocalUno({ cardId: card.id }));
    return;
  }
  if (!playable.has(card.id)) {
    showToast('这张牌现在不能出', 'warn');
    return;
  }
  if (card.kind === 'wild' || card.kind === 'wild4') {
    openColorModal('play', card.id);
    return;
  }
  gameAction('game:playCard', withLocalUno({ cardId: card.id }));
}

function handSuffix() {
  const game = ui.game;
  if (!game) return '';
  const count = game.yourHand?.length ?? 0;
  if (game.window?.kind === 'snipe' && game.window.canSnipe) return '点击高亮手牌抢出同名牌。';
  if (game.window?.kind === 'follow' && game.window.isYou) return '点击高亮手牌跟出，或选择跳过。';
  if (game.drawChoice?.isYou && game.drawChoice.forceDraw) {
    const canPlay = (game.playableCardIds || []).includes(game.drawChoice.cardId);
    return canPlay ? '点击高亮牌打出，或继续抽牌。' : '必须继续抽牌，直到抽到能打出的牌。';
  }
  if (game.drawChoice?.isYou && game.drawChoice.mustPlay) return '这张牌必须打出。';
  if (game.roundOver) return '本局已经结束。';
  return `手牌 ${count} 张`;
}

function renderActions() {
  const game = ui.game;
  const bar = $('game-actions');
  bar.innerHTML = '';
  $('hand-hint').textContent = handSuffix();
  if (!game || game.roundOver) return;
  const me = myGamePlayer();
  if (!me) return;

  const addButton = (label, className, onClick, { hot = false, disabled = false } = {}) => {
    const button = node('button', `win-btn action-btn ${className || ''}${hot ? ' hot' : ''}`.trim(), label);
    button.type = 'button';
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    bar.appendChild(button);
    return button;
  };

  const yourTurn = isMyTurn();
  const awaitingColor = Boolean(game.awaitingColor);

  if (game.awaitingColor?.isYou) {
    addButton('选择颜色', 'color-btn', () => openColorModal('initial'), { hot: true });
  }

  if (game.window?.kind === 'follow' && game.window.isYou) {
    addButton('跳过跟牌', '', () => gameAction('game:follow', { cardId: null }));
  }

  const continuingForceDraw = Boolean(game.drawChoice?.isYou && game.drawChoice.forceDraw);
  if (yourTurn && !game.window && !awaitingColor && (!game.drawChoice || continuingForceDraw)) {
    const forceCanPlay = continuingForceDraw
      && (game.playableCardIds || []).includes(game.drawChoice.cardId);
    const penalty = game.challenge
      ? game.challenge.count
      : game.pendingDraw?.count;
    const drawLabel = continuingForceDraw
      ? '继续抽牌'
      : penalty
        ? `接受 +${penalty}`
        : game.config.forceDrawUntilPlayable
          ? '抽到能出为止'
          : '抽一张牌';
    addButton(drawLabel, 'draw-btn', () => gameAction('game:drawCard', {}), {
      hot: continuingForceDraw ? !forceCanPlay : !game.challenge && !game.pendingDraw,
    });
  }

  if (game.challenge?.isChallenger) {
    addButton('质疑 +4', 'challenge-btn', () => gameAction('game:challenge', {}), { hot: true });
  }

  if (game.drawChoice?.isYou && !game.drawChoice.mustPlay && !game.drawChoice.forceDraw) {
    addButton('结束回合', '', () => gameAction('game:endTurn', {}));
  }

  const handCount = me.handCount;
  if (handCount === 1 && !me.uno) {
    addButton('UNO!', 'uno-btn', () => gameAction('game:callUno', {}), {
      hot: Boolean(me.unoExposed),
    });
    bar.lastElementChild?.classList.toggle('flash', Boolean(me.unoExposed));
  } else if (canDeclareUnoLocally()) {
    const localButton = addButton(
      ui.localUnoPending ? 'UNO! 已就绪' : 'UNO!',
      'uno-btn',
      () => {
        ui.localUnoPending = !ui.localUnoPending;
        renderActions();
      },
    );
    localButton.classList.toggle('local-armed', ui.localUnoPending);
    localButton.title = ui.localUnoPending
      ? '本次出牌将同时喊 UNO，再次点击可取消'
      : '点击后在本次出牌的同时喊 UNO';
  }

  if (game.window?.kind === 'snipe' && game.window.canSnipe) {
    addButton('放弃抢出', 'pass-snipe-btn', async () => {
      const response = await gameAction('game:passSnipe', { windowId: game.window.id });
      if (response?.ok) showToast('已放弃本次抢出');
    });
    const note = node('span', 'action-note', '点击高亮牌抢出');
    note.style.cssText = 'color:#ffe39a;font-size:11px;';
    bar.appendChild(note);
  }

}

function isCurrentPlayerOffline() {
  const game = ui.game;
  if (!game?.deadlines?.turn || game.roundOver) return false;
  const current = game.players.find((player) => player.id === game.currentPlayerId);
  return Boolean(current && !current.connected && !current.isBot);
}

function renderBanner() {
  const game = ui.game;
  const banner = $('game-banner');
  const text = $('banner-text');
  if (!game) return;
  banner.classList.remove('urgent');
  let message = '';
  let urgent = false;

  if (game.roundOver) {
    if (ui.room?.phase === 'GAME_END') {
      message = '本场比赛已结束，可查看最终排名。';
    } else {
      message = roundRevealReadyKey && roundRevealReadyKey === currentRoundResultKey()
        ? '本局已结束，可查看结算。'
        : '本局结算中…';
    }
  } else if (game.window?.kind === 'snipe') {
    if (game.window.canSnipe) {
      message = '抢出窗口：你有同名牌，点击高亮牌抢先打出，或选择放弃抢出。';
      urgent = true;
    } else if (game.window.passed) {
      message = '你已放弃本次抢出，等待其他玩家…';
    } else {
      message = '抢出窗口开启，其他玩家可能正在思考…';
    }
  } else if (game.window?.kind === 'follow') {
    if (game.window.isYou) {
      message = '抢出成功！可跟出一张普通牌，或跳过。';
      urgent = true;
    } else {
      message = `等待 ${playerName(game.window.playerId)} 选择是否跟牌…`;
    }
  } else if (game.challenge) {
    if (game.challenge.isChallenger) {
      message = `上家打出 Wild +4。质疑若成功对方罚抽 4 张，失败则你罚抽 6 张。`;
      urgent = true;
    } else {
      message = `等待 ${playerName(game.challenge.challengerId)} 决定是否质疑 Wild +4…`;
    }
  } else if (game.awaitingColor) {
    if (game.awaitingColor.isYou) {
      message = '首张 Wild：请选择接下来的颜色。';
      urgent = true;
    } else {
      message = `等待 ${playerName(game.awaitingColor.playerId)} 选择颜色…`;
    }
  } else if (game.drawChoice?.isYou) {
    if (game.drawChoice.forceDraw) {
      const canPlay = (game.playableCardIds || []).includes(game.drawChoice.cardId);
      message = canPlay
        ? '抽到了可出的牌：可以打出它，或继续抽牌直到愿意打出。'
        : '抽到了不能出的牌，正在逐张继续抽牌…';
    } else {
      message = game.drawChoice.mustPlay
        ? '抽到了可出的牌，本回合必须打出它。'
        : '已抽牌：可以打出刚抽到的牌，或结束回合。';
    }
    urgent = true;
  } else if (isCurrentPlayerOffline()) {
    message = `${currentPlayerName()} 已离线，倒计时结束后将自动跳过其回合。`;
  } else if (isMyTurn()) {
    if (game.pendingDraw?.count > 0) {
      message = `轮到你处理罚抽：可叠加罚抽牌，或接受 +${game.pendingDraw.count}。`;
      urgent = true;
    } else if ((game.playableCardIds || []).length === 0) {
      message = game.config.forceDrawUntilPlayable
        ? '没有可出的牌：必须抽到能出的牌并打出。'
        : '没有可出的牌：从抽牌堆抽一张。';
      urgent = true;
    } else if (game.config.forceDrawUntilPlayable) {
      message = '轮到你出牌；若选择抽牌，将一直抽到能出并打出。';
      urgent = true;
    } else {
      message = '轮到你了：点击高亮手牌出牌，或选择抽牌。';
      urgent = true;
    }
  } else if (game.pendingDraw?.count > 0) {
    message = `等待 ${currentPlayerName()} 处理 +${game.pendingDraw.count} 罚抽。`;
  } else {
    message = `等待 ${currentPlayerName()} 出牌…`;
  }

  text.textContent = message;
  banner.classList.toggle('urgent', urgent);
  updateCountdown();
}

function updateCountdown() {
  const game = ui.game;
  const timer = $('banner-timer');
  if (!game) {
    timer.textContent = '';
    return;
  }
  const now = Date.now() + ui.serverOffset;
  let deadline = 0;
  if (game.window) deadline = game.deadlines?.window || 0;
  else if (game.challenge) deadline = game.deadlines?.challenge || 0;
  else if (game.deadlines?.turn) deadline = game.deadlines.turn;
  if (!deadline) {
    timer.textContent = '';
    return;
  }
  const remain = Math.max(0, (deadline - now) / 1000);
  if (remain <= 0) {
    timer.textContent = '0.0s';
    return;
  }
  timer.textContent = `${remain < 10 ? remain.toFixed(1) : Math.ceil(remain)}s`;
}

setInterval(updateCountdown, 180);

function renderLog() {
  const log = $('game-log');
  log.innerHTML = '';
  const entries = (ui.game?.log || []).slice(-6);
  for (const entry of entries) {
    log.appendChild(node('div', `log-item ${entry.type || ''}`, entry.message));
  }
  if (entries.length === 0) {
    log.appendChild(node('div', 'log-item', '牌局刚刚开始…'));
  }
}

/* ---------------- Overlays ---------------- */

function currentRoundResultKey() {
  const game = ui.game;
  if (!game?.roundOver || !game.roundResult || !ui.room || ui.room.phase !== 'ROUND_END') return null;
  return `round:${game.roundNumber}:${game.roundResult.winnerId}`;
}

function resetRoundReveal() {
  if (roundRevealTimer) clearTimeout(roundRevealTimer);
  roundRevealTimer = null;
  roundRevealKey = null;
  roundRevealReadyKey = null;
  ui.roundMinimized = false;
}

function updateSettlementRestore() {
  const button = $('settlement-restore');
  if (!button) return;
  let label = null;
  if (
    ui.roundMinimized
    && ui.room?.phase === 'ROUND_END'
    && currentRoundResultKey()
    && roundRevealReadyKey === currentRoundResultKey()
  ) {
    label = '查看本局结算';
  } else if (ui.matchMinimized && ui.room?.phase === 'GAME_END' && ui.room.matchSummary) {
    label = '查看最终排名';
  }
  button.hidden = !label;
  if (label) button.textContent = label;
}

function renderRoundOverlay() {
  const game = ui.game;
  const overlay = $('round-end-overlay');
  if (!game?.roundOver || !ui.room || ui.room.phase !== 'ROUND_END' || !game.roundResult) {
    overlay.hidden = true;
    resetRoundReveal();
    updateSettlementRestore();
    return;
  }

  const key = currentRoundResultKey();
  if (!key) {
    overlay.hidden = true;
    updateSettlementRestore();
    return;
  }
  if (roundRevealKey !== key) {
    if (roundRevealTimer) clearTimeout(roundRevealTimer);
    roundRevealKey = key;
    roundRevealReadyKey = null;
    ui.roundMinimized = false;
    roundRevealTimer = setTimeout(() => {
      roundRevealTimer = null;
      if (roundRevealKey !== key) return;
      roundRevealReadyKey = key;
      if (ui.game && currentRoundResultKey() === key) {
        renderRoundOverlay();
        renderBanner();
      }
    }, 1000);
  }
  if (roundRevealReadyKey !== key) {
    overlay.hidden = true;
    updateSettlementRestore();
    return;
  }
  if (ui.roundMinimized) {
    overlay.hidden = true;
    updateSettlementRestore();
    return;
  }

  const result = game.roundResult;
  const wasHidden = overlay.hidden;
  overlay.hidden = false;
  if (wasHidden) clearToasts();
  $('round-end-title').textContent = `${result.winnerName} 获胜`;
  $('round-end-sub').textContent = '率先出完手牌 · 本局记 0 分';
  const gainedFor = (playerId) => result.scoreGained?.[playerId] ?? result.cardPoints?.[playerId] ?? 0;
  const standings = [...game.players].sort((a, b) => {
    if (a.id === result.winnerId) return -1;
    if (b.id === result.winnerId) return 1;
    return gainedFor(a.id) - gainedFor(b.id)
      || a.score - b.score
      || a.name.localeCompare(b.name, 'zh');
  });
  const list = $('round-end-scores');
  list.innerHTML = '';
  standings.forEach((player, index) => {
    const row = node('div', `score-row${player.id === result.winnerId ? ' winner' : ''}`);
    row.append(node('span', 'score-rank', String(index + 1)));
    const name = node('div', 'score-name');
    name.append(node('span', '', player.name));
    if (player.isBot) name.append(node('span', 'tag bot', '电脑'));
    row.appendChild(name);
    const isWinner = player.id === result.winnerId;
    const gained = gainedFor(player.id);
    const detail = isWinner ? '出完手牌 +0' : `本局 +${gained}`;
    row.append(node('span', 'score-gain', detail), node('span', 'score-total', `${player.score} 分`));
    list.appendChild(row);
  });
  updateSettlementRestore();

  const host = isHost();
  $('next-round-btn').hidden = !host;
  $('end-match-btn').hidden = !host;
  $('wait-host-note').hidden = host;
  $('next-round-btn').disabled = !ui.room.canStart;
  const hint = $('result-hint');
  const scoreNote = '余牌点数计入本人积分，积分越低越好。';
  if (host) {
    const unready = ui.room.players.filter((player) => !player.isBot && player.connected && !player.ready);
    if (ui.room.players.length < 2) hint.textContent = `${scoreNote} 至少需要 2 名玩家才能开始下一局。`;
    else if (unready.length) hint.textContent = `${scoreNote} 等待 ${unready.map((player) => player.name).join('、')} 准备后即可开始。`;
    else hint.textContent = `${scoreNote} 房主也可以结束整场，按累计积分锁定最终排名。`;
  } else {
    hint.textContent = `${scoreNote} 等待房主开始下一局或结束整场。`;
  }
}

function renderMatchOverlay() {
  const overlay = $('match-end-overlay');
  const summary = ui.room?.matchSummary;
  if (!ui.room || ui.room.phase !== 'GAME_END' || !summary) {
    overlay.hidden = true;
    if (ui.room?.phase === 'LOBBY' || !ui.room) ui.matchMinimized = false;
    updateSettlementRestore();
    return;
  }
  if (ui.matchMinimized) {
    overlay.hidden = true;
    updateSettlementRestore();
    return;
  }
  const wasHidden = overlay.hidden;
  overlay.hidden = false;
  if (wasHidden) clearToasts();
  const list = $('match-end-scores');
  list.innerHTML = '';
  for (const row of summary.standings) {
    const scoreRow = node('div', `score-row${row.rank === 1 ? ' winner' : ''}`);
    scoreRow.append(node('span', 'score-rank', String(row.rank)));
    const name = node('div', 'score-name');
    name.append(node('span', '', row.name));
    if (row.isBot) name.append(node('span', 'tag bot', '电脑'));
    scoreRow.appendChild(name);
    scoreRow.append(node('span', 'score-gain', ''), node('span', 'score-total', `${row.score} 分`));
    list.appendChild(scoreRow);
  }
  updateSettlementRestore();
  const host = isHost();
  $('new-match-btn').hidden = !host;
  $('new-match-wait').hidden = host;
}

$('round-end-minimize').addEventListener('click', () => {
  if (!ui.game?.roundOver || $('round-end-overlay').hidden) return;
  ui.roundMinimized = true;
  renderRoundOverlay();
});

$('match-end-minimize').addEventListener('click', () => {
  if (ui.room?.phase !== 'GAME_END' || $('match-end-overlay').hidden) return;
  ui.matchMinimized = true;
  renderMatchOverlay();
});

$('settlement-restore').addEventListener('click', () => {
  if (ui.room?.phase === 'GAME_END') {
    ui.matchMinimized = false;
    renderMatchOverlay();
    return;
  }
  ui.roundMinimized = false;
  renderRoundOverlay();
});

function openColorModal(context, cardId = null) {
  ui.colorContext = context;
  ui.pendingWildCardId = cardId;
  $('color-modal-title').textContent = context === 'initial' ? '首张 Wild：选择颜色' : '打出 Wild：选择颜色';
  $('color-modal-close').hidden = context === 'initial';
  $('color-modal').hidden = false;
}

function closeColorModal() {
  if (ui.colorContext === 'initial') return;
  $('color-modal').hidden = true;
  ui.colorContext = null;
  ui.pendingWildCardId = null;
}

function syncColorModal() {
  const game = ui.game;
  const modal = $('color-modal');
  if (!game || game.roundOver) {
    modal.hidden = true;
    if (ui.colorContext === 'initial') ui.colorContext = null;
    return;
  }
  if (ui.colorContext === 'play') {
    const stillHas = (game.yourHand || []).some((card) => card.id === ui.pendingWildCardId);
    const canPlay = (game.playableCardIds || []).includes(ui.pendingWildCardId);
    if (!stillHas || !canPlay) {
      modal.hidden = true;
      ui.colorContext = null;
      ui.pendingWildCardId = null;
    }
    return;
  }
  if (game.awaitingColor?.isYou) {
    if (ui.colorContext !== 'initial') openColorModal('initial');
  } else if (ui.colorContext === 'initial') {
    modal.hidden = true;
    ui.colorContext = null;
  }
}

$('color-modal-close').addEventListener('click', closeColorModal);
$('color-grid').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-color]');
  if (!button) return;
  const color = button.dataset.color;
  const context = ui.colorContext;
  if (!context) return;
  const buttons = [...$('color-grid').querySelectorAll('button')];
  for (const item of buttons) item.disabled = true;
  let response;
  if (context === 'initial') {
    response = await request('game:chooseColor', { color });
  } else {
    response = await request('game:playCard', withLocalUno({
      cardId: ui.pendingWildCardId,
      chosenColor: color,
    }));
  }
  for (const item of buttons) item.disabled = false;
  if (!response?.ok) {
    showToast(response?.message || '操作失败', 'error');
    return;
  }
  $('color-modal').hidden = true;
  ui.colorContext = null;
  ui.pendingWildCardId = null;
});

$('color-modal').addEventListener('click', (event) => {
  if (event.target === $('color-modal')) closeColorModal();
});

$('draw-pile').addEventListener('click', () => {
  if (canDrawNow()) gameAction('game:drawCard', {});
});
$('draw-pile').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (canDrawNow()) gameAction('game:drawCard', {});
  }
});

/* ---------------- Socket lifecycle ---------------- */

function handleServerError(payload) {
  const now = Date.now();
  if (ui.lastToastKey === `error:${payload?.message}` && now - ui.lastToastAt < 900) return;
  showToast(payload?.message || '操作失败', 'error');
}

socket.on('connect', async () => {
  setNetworkState('online');
  setConnectionOverlay(false);
  if (ui.sessionReplaced) {
    refreshLobbyList({ silent: true });
    return;
  }
  if (ui.currentCode && ui.token) {
    await attemptRejoin();
  }
  if (!ui.room) refreshLobbyList({ silent: true });
});

socket.on('disconnect', () => {
  clearForcedDrawTimer();
  setNetworkState('offline');
  if ((ui.room || (ui.currentCode && ui.token)) && !ui.intentionalLeave) {
    setConnectionOverlay(true, '连接中断', '正在尝试重新连接服务器…');
  }
});

socket.io.on('reconnect_attempt', () => {
  setNetworkState('connecting');
  if ((ui.room || (ui.currentCode && ui.token)) && !ui.intentionalLeave) {
    setConnectionOverlay(true, '正在重新连接', '正在恢复你的座位与手牌…');
  }
});

socket.on('connect_error', () => {
  setNetworkState('offline');
  if ((ui.room || (ui.currentCode && ui.token)) && !ui.intentionalLeave) {
    setConnectionOverlay(true, '无法连接服务器', '正在后台重试。请检查网络连接。');
  }
});

socket.on('lobby:update', (payload) => {
  if (Array.isArray(payload?.rooms)) setLobbyRooms(payload.rooms);
});

socket.on('room:update', (room) => {
  applyRoom(room);
});

socket.on('game:state', (game) => {
  setConnectionOverlay(false);
  applyGame(game);
});

socket.on('game:event', (payload) => {
  for (const event of payload?.events || []) {
    if (!event?.message) continue;
    if (event.type==='card-played')continue;
    let kind = 'info';
    if (['uno-called', 'uno-pre-called', 'uno-caught', 'uno-exposed'].includes(event.type)) kind = 'uno';
    else if (['penalty-draw', 'turn-timeout', 'challenge-result'].includes(event.type)) kind = 'warn';
    else if (event.type === 'round-end' || event.type === 'match-end') kind = 'info';
    showToast(event.message, kind);
  }
});

socket.on('game:error', handleServerError);
socket.on('session:replaced', () => {
  const oldCode = ui.currentCode;
  ui.sessionReplaced = true;
  ui.token = null;
  ui.currentCode = null;
  ui.room = null;
  ui.game = null;
  ui.meId = null;
  setConnectionOverlay(false);
  hideOverlaysForNoGame();
  setUrlRoom(null);
  if (oldCode) joinCodeInput.value = oldCode;
  showScreen('home');
  if (socket.connected) refreshLobbyList({ silent: true });
  showToast('你的座位已在另一个页面恢复，本页已断开连接。', 'warn', { duration: 4500 });
});

async function attemptRejoin() {
  if (ui.rejoining) return;
  if (!ui.currentCode || !ui.token) return;
  ui.rejoining = true;
  pushLoading('正在恢复牌局…');
  const response = await request('room:rejoin', { code: ui.currentCode, token: ui.token });
  popLoading();
  ui.rejoining = false;
  if (response?.ok) {
    applySession(response.code, response.playerId, response.token);
    if (response.room) applyRoom(response.room);
    setConnectionOverlay(false);
    if (ui.room?.phase === 'PLAYING' || ui.room?.phase === 'ROUND_END' || ui.room?.phase === 'GAME_END') {
      routeScreen();
    }
    return;
  }
  setConnectionOverlay(false);
  if (['INVALID_TOKEN', 'ROOM_NOT_FOUND', 'BAD_TOKEN', 'NO_SESSION'].includes(response?.code)) {
    const failedCode = ui.currentCode;
    if (failedCode) removeToken(failedCode);
    ui.token = null;
    ui.currentCode = null;
    ui.room = null;
    ui.game = null;
    ui.meId = null;
    hideOverlaysForNoGame();
    setUrlRoom(failedCode);
    joinCodeInput.value = failedCode || '';
    showScreen('home');
    if (socket.connected) refreshLobbyList({ silent: true });
    showToast('无法恢复上次牌局，请重新加入', 'warn');
    return;
  }
  showToast(response?.message || '恢复牌局失败', 'error');
  if (ui.currentCode && ui.token) {
    setConnectionOverlay(true, '恢复失败', '连接已恢复，但牌局状态同步失败。');
  }
}

$('connection-home').addEventListener('click', () => {
  clearSessionState();
  setConnectionOverlay(false);
  try {
    socket.disconnect();
    socket.connect();
  } catch {
    /* ignore */
  }
});

/* ---------------- Initial boot ---------------- */

function boot() {
  setupHandLayoutObserver();
  setNetworkState(socket.connected ? 'online' : 'connecting');
  nameInput.value ||= '';
  if (initialRoomCode) {
    joinCodeInput.value = initialRoomCode;
    const token = savedToken(initialRoomCode);
    if (token) {
      ui.currentCode = initialRoomCode;
      ui.token = token;
      pushLoading('正在恢复上次牌局…');
      if (socket.connected) {
        attemptRejoin().finally(popLoading);
      } else {
        // connect handler will attempt; remove the boot overlay after the attempt.
        const release = () => {
          popLoading();
          socket.off('connect', release);
          socket.off('connect_error', release);
        };
        socket.once('connect', release);
        socket.once('connect_error', release);
      }
      return;
    }
  }
  showScreen('home');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
