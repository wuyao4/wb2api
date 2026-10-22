/**
 * Buddy2API console.
 *
 * Single module, no framework: the dashboard is a handful of routed views over
 * one server snapshot. Everything that mutates state goes through `api()` and
 * then re-reads the snapshot, so the UI can never drift from the backend.
 */

const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  models: [],
  logs: [],
  view: 'overview',
  channelFilter: 'all',
  channelQuery: '',
  connectQuery: '',
  connectSelected: '',
  connectSignature: '',
  connect: [],
  modelSelect: null,
  contextSelect: null,
  modelTouched: false,
  contextTouched: false,
  lastServerKey: '',
  loginBusy: false,
  loginTimer: null,
  oauthTimer: null,
  oauthPopup: null,
  oauthGeneration: 0,
  oauthState: '',
  oauthProvider: '',
  clipboardTimer: null,
  clipboardSignature: '',
  smsState: '',
  logsSignature: '',
  statusErrorShown: false,
  refreshing: false,
  loginChannelId: '',
  poolFilter: 'all',
  editSubmit: null,
  openChannels: new Set(),
  channelPoolSignature: '',
  testModelSelect: null,
  testChannelSelect: null,
  testChannel: null,
  testBusy: false,
  lastTestOutput: '',
  poolQuery: '',
  logQuery: '',
  modelsLoading: false,
  commandIndex: 0,
  commandFiltered: []
};

/* ========================================================================== */
/* helpers                                                                    */
/* ========================================================================== */

function messageFrom(data, res) {
  if (typeof data?.error === 'string') return data.error;
  if (data?.error?.message) return data.error.message;
  if (data?.message) return data.message;
  return `请求失败（HTTP ${res.status}）`;
}

async function api(path, options = {}, retried = false) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const adminToken = sessionStorage.getItem('wb2api_admin');
  if (adminToken) headers['X-Admin-Token'] = adminToken;

  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }

  if (res.status === 403 && !retried) {
    const token = prompt('管理接口需要 X-Admin-Token（config.json 中的 server.adminToken）：');
    if (token) {
      sessionStorage.setItem('wb2api_admin', token.trim());
      return api(path, options, true);
    }
  }

  if (!res.ok) {
    const err = new Error(messageFrom(data, res));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(message, type = 'info') {
  const stack = $('toastStack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${type === 'info' ? '' : type}`.trim();
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  }, 3800);
}

function setBusy(button, busy) {
  if (!button) return;
  button.classList.toggle('is-busy', busy);
  // Always clear the attribute when an operation ends; a button left disabled
  // after a completed action can never be clicked again.
  button.disabled = Boolean(busy);
}

function setMsg(el, text, kind) {
  if (!el) return;
  el.textContent = text || '';
  el.className = 'inline-msg' + (kind ? ` is-${kind}` : '');
}

function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatContext(value) {
  if (!value) return '模型默认';
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`;
  return `${Math.round(value / 1000)}K`;
}

function formatUptime(seconds) {
  if (seconds == null) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function expiryInfo(iso) {
  if (!iso) return { text: '无凭据', cls: '' };
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return { text: '未知', cls: '' };
  const diff = time - Date.now();
  if (diff <= 0) return { text: 'Token 已过期', cls: 'is-bad' };
  const days = Math.floor(diff / 86_400_000);
  if (days >= 1) return { text: `${days} 天后到期`, cls: days < 7 ? 'is-warn' : '' };
  const hours = Math.max(1, Math.floor(diff / 3_600_000));
  return { text: `${hours} 小时后到期`, cls: 'is-warn' };
}

function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return null;
  }
}

function findTokens(text) {
  const found = [];
  const seen = new Set();
  const re = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
  for (const token of String(text || '').match(re) || []) {
    if (seen.has(token)) continue;
    seen.add(token);
    const payload = decodeJwt(token);
    found.push({
      token,
      kind: String(payload?.typ || '').toLowerCase() === 'offline' ? 'refresh' : 'access',
      exp: Number(payload?.exp) || 0
    });
  }
  return found;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(node) {
  if (node) node.replaceChildren();
}

const PROVIDER_CODES = {
  workbuddy: 'WB',
  codebuddy: 'CB',
  kilo: 'KG',
  openrouter: 'OR',
  groq: 'GQ',
  deepseek: 'DS',
  gemini: 'GM',
  siliconflow: 'SF',
  nvidia: 'NV',
  cerebras: 'CR',
  mistral: 'MI',
  together: 'TG',
  fireworks: 'FW',
  xai: 'XA',
  moonshot: 'MS',
  zai: 'ZA',
  minimax: 'MM',
  'opencode-zen': 'OC',
  vercel: 'VC',
  cline: 'CL',
  qoder: 'QD',
  'gemini-code-assist': 'GC',
  trae: 'TR',
  raccoon: 'RC',
  zcode: 'ZC',
  'minimax-code': 'MC',
  loomy: 'LM',
  lobsterai: 'LB'
};

/** A deterministic, readable channel mark (no remote favicons). */
function providerMark(id, label, size = '') {
  const key = String(id || label || '?').toLowerCase();
  let code = PROVIDER_CODES[key];
  if (!code) {
    const words = String(label || id || '?').match(/[A-Za-z0-9]+/g);
    code = words?.length
      ? words.map((word) => word[0]).join('').slice(0, 2).toUpperCase()
      : String(label || id || '?').slice(0, 2);
  }
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const node = el('span', `provider-mark${size ? ` ${size}` : ''}`, code);
  node.style.setProperty('--mark-hue', String(hash % 360));
  node.title = label || id || '';
  return node;
}

function setMobileMenu(open) {
  const sidebar = document.querySelector('.sidebar');
  const backdrop = $('sidebarBackdrop');
  sidebar?.classList.toggle('is-open', open);
  if (backdrop) backdrop.hidden = !open;
  document.body.classList.toggle('menu-open', open);
}

function openTestModel(model) {
  if (!model) return;
  setView('test');
  state.testChannel = model.channel || '';
  renderTestModels();
  if (state.testModelSelect?.hasValue(model.id)) {
    state.testModelSelect.setValue(model.id);
  }
  updateTestModelHint();
  setTimeout(() => $('testInput')?.focus(), 80);
}

function commandCatalog() {
  const running = Boolean(state.status?.running);
  const commands = [
    { section: '页面', label: '概览', hint: '网关状态与请求链路', keywords: 'overview home dashboard', run: () => setView('overview') },
    { section: '页面', label: '渠道', hint: '上游渠道与凭据', keywords: 'channels upstream', run: () => setView('channels') },
    { section: '页面', label: '连接', hint: 'OAuth 与 API Key', keywords: 'connect oauth key', run: () => setView('connect') },
    { section: '页面', label: '代理池', hint: '账号、并发与会话', keywords: 'accounts pool', run: () => setView('accounts') },
    { section: '页面', label: '测试', hint: '选择模型发一轮对话', keywords: 'test playground model', run: () => setView('test') },
    { section: '页面', label: '日志', hint: '最近请求与错误', keywords: 'logs requests', run: () => setView('logs') },
    { section: '页面', label: '设置', hint: '模型路由与运行信息', keywords: 'settings routing', run: () => setView('settings') },
    {
      section: '操作',
      label: running ? '更新并应用网关' : '启动网关',
      hint: running ? '重新校验并应用当前配置' : '校验渠道并开放 /v1',
      keywords: 'start gateway run',
      run: startProxy
    },
    { section: '操作', label: '刷新状态', hint: '重新读取渠道与账号', keywords: 'refresh reload', run: async () => { await refreshStatus(); await loadModels(true); toast('已刷新', 'success'); } },
    { section: '操作', label: '添加账号', hint: '打开浏览器授权', keywords: 'account login add', run: addAccountFlow },
    { section: '操作', label: '连接新渠道', hint: 'OAuth 或 API Key', keywords: 'connect provider', run: () => setView('connect') },
    { section: '操作', label: '复制 Base URL', hint: state.status?.baseUrl || '网关未启动', keywords: 'copy base url', run: () => copyBaseUrl() },
    { section: '操作', label: '复制 API Key', hint: state.status?.apiKey ? '复制当前网关密钥' : '尚未生成密钥', keywords: 'copy api key', run: () => copyApiKey() },
    { section: '操作', label: '重新读取配置', hint: '应用 config.json 变更', keywords: 'reload config', run: reloadConfig }
  ];
  if (running) {
    commands.splice(8, 0, {
      section: '操作',
      label: '停止网关',
      hint: '保留配置，只关闭 /v1',
      keywords: 'stop gateway halt',
      run: stopProxy
    });
  }
  return commands;
}

async function copyBaseUrl() {
  const value = state.status?.baseUrl || '';
  if (!value) return toast('网关还没有启动', 'warn');
  const ok = await copyText(value);
  toast(ok ? 'Base URL 已复制' : '复制失败', ok ? 'success' : 'error');
}

async function copyApiKey() {
  const value = state.status?.apiKey || '';
  if (!value) return toast('还没有 API Key', 'warn');
  const ok = await copyText(value);
  toast(ok ? 'API Key 已复制' : '复制失败', ok ? 'success' : 'error');
}

function renderCommandResults(query = '') {
  const box = $('commandResults');
  if (!box) return;
  const q = query.trim().toLowerCase();
  const commands = commandCatalog();
  const matches = (item) =>
    !q || `${item.label} ${item.hint} ${item.keywords}`.toLowerCase().includes(q);
  const views = commands.filter((item) => item.section === '页面' && matches(item));
  const actions = commands.filter((item) => item.section === '操作' && matches(item));
  const models =
    q && state.models.length
      ? state.models
          .filter((model) =>
            `${model.id} ${model.name || ''} ${model.channel_label || ''}`
              .toLowerCase()
              .includes(q)
          )
          .slice(0, 8)
      : [];

  const rows = [];
  for (const item of [...views, ...actions]) rows.push({ ...item, type: 'command' });
  for (const model of models) {
    rows.push({
      type: 'model',
      section: '模型',
      label: model.id,
      hint: `${model.channel_label || model.channel || '渠道'} · ${model.name || '模型'}`,
      run: () => openTestModel(model)
    });
  }

  state.commandFiltered = rows;
  state.commandIndex = Math.min(state.commandIndex, Math.max(0, rows.length - 1));
  clear(box);

  if (!rows.length) {
    box.appendChild(
      el('div', 'command-empty', q ? '没有匹配的页面、操作或模型' : '没有可执行项')
    );
    $('commandHint').textContent = '0 项';
    return;
  }

  let lastSection = '';
  rows.forEach((row, index) => {
    if (row.section !== lastSection) {
      box.appendChild(el('div', 'command-section', row.section));
      lastSection = row.section;
    }
    const button = el('button', `command-item${index === state.commandIndex ? ' is-active' : ''}`);
    button.type = 'button';
    button.dataset.index = String(index);
    button.appendChild(el('span', `command-icon${row.type === 'model' ? ' model' : ''}`, row.type === 'model' ? 'M' : row.label.slice(0, 1)));
    const copy = el('span', 'command-copy');
    copy.appendChild(el('strong', '', row.label));
    copy.appendChild(el('span', '', row.hint));
    button.appendChild(copy);
    button.addEventListener('mouseenter', () => {
      state.commandIndex = index;
      for (const item of box.querySelectorAll('.command-item')) {
        item.classList.toggle('is-active', Number(item.dataset.index) === index);
      }
    });
    button.addEventListener('click', () => executeCommand(row));
    box.appendChild(button);
  });
  $('commandHint').textContent = `${rows.length} 项`;
}

function executeCommand(item) {
  const dialog = $('commandDialog');
  if (!item) return;
  if (dialog?.open) dialog.close();
  Promise.resolve()
    .then(() => item.run?.())
    .catch((err) => toast(err.message, 'error'));
}

function openCommandPalette() {
  const dialog = $('commandDialog');
  if (!dialog) return;
  setMobileMenu(false);
  if (dialog.open) {
    $('commandInput')?.focus();
    return;
  }
  state.commandIndex = 0;
  $('commandInput').value = '';
  renderCommandResults('');
  dialog.showModal();
  setTimeout(() => $('commandInput')?.focus(), 30);
}

function moveCommand(delta) {
  const rows = state.commandFiltered;
  if (!rows.length) return;
  state.commandIndex = (state.commandIndex + delta + rows.length) % rows.length;
  const box = $('commandResults');
  for (const item of box.querySelectorAll('.command-item')) {
    const active = Number(item.dataset.index) === state.commandIndex;
    item.classList.toggle('is-active', active);
    if (active) item.scrollIntoView({ block: 'nearest' });
  }
}

/* ---------------------------------------------------------- derived state */

function activeChannels() {
  return Array.isArray(state.status?.channels) ? state.status.channels : [];
}

function isConfigured() {
  const channels = activeChannels();
  if (channels.length) return channels.some((c) => c.enabled !== false && c.configured);
  return !!(state.status?.user || state.status?.token?.expiresAt);
}

function defaultChannelStatus() {
  const channels = activeChannels();
  if (!channels.length) return null;
  const model = String(state.status?.defaultModel || '');
  const prefix = model.includes('/') ? model.slice(0, model.indexOf('/')) : '';
  return channels.find((c) => c.id === prefix) || channels[0];
}

function contextWindowForModel(model) {
  const channel = activeChannels().find((entry) => entry.id === model?.channel);
  return channel?.models?.contextWindow || state.status?.models?.contextWindow || {};
}

/** All channels that can own browser-login accounts (WorkBuddy / CodeBuddy). */
function loginChannels() {
  return activeChannels().filter((channel) => channel.enabled !== false && channel.capabilities?.login);
}

/** The channel currently selected in the add-account card. */
function loginChannelStatus() {
  const channels = loginChannels();
  return channels.find((channel) => channel.id === state.loginChannelId) || channels[0] || null;
}

function channelById(id) {
  return activeChannels().find((channel) => channel.id === id) || null;
}

function accountsOf(channel) {
  return Array.isArray(channel?.accounts) ? channel.accounts : [];
}

function accountName(account) {
  return account.username || account.email || account.label || account.maskedApiKey || account.id || '账号';
}

function accountKind(account) {
  if (account.channelType === 'openai-compatible') return 'key';
  if (account.channelType === 'workbuddy' || account.channelType === 'codebuddy') return 'oauth';
  return 'oauth';
}

/**
 * Flatten every channel's live accounts into one scheduler pool.
 *
 * A channel can expose accounts that are not the "default" channel (OAuth
 * providers, CodeBuddy, additional WorkBuddy logins). The old accounts view
 * only rendered `status.accounts` (the default channel), which is why newly
 * authorized channels looked like they were never added to the pool.
 */
function poolEntries() {
  const rows = [];
  for (const channel of activeChannels()) {
    for (const account of accountsOf(channel)) {
      rows.push({
        ...account,
        channel: channel.id,
        channelLabel: channel.label || channel.id,
        channelType: channel.type,
        channelEnabled: channel.enabled !== false,
        channelConfigured: Boolean(channel.configured),
        channelOptions: channel.options || {},
        capabilities: channel.capabilities || {}
      });
    }
  }
  return rows;
}

function poolStats() {
  const rows = poolEntries();
  const usable = rows.filter(
    (account) => account.enabled !== false && account.channelEnabled !== false
  );
  return {
    accounts: rows.length,
    active: usable.length,
    channels: new Set(rows.map((account) => account.channel)).size,
    maxConcurrency: usable.reduce(
      (sum, account) => sum + (Number(account.maxConcurrency) || 1),
      0
    ),
    sessions: rows.reduce((sum, account) => sum + (Number(account.sessions) || 0), 0),
    cooling: rows.filter((account) => account.coolingDown).length
  };
}

function poolPassesFilter(account) {
  if (state.poolFilter === 'active') {
    return account.enabled !== false && account.channelEnabled !== false;
  }
  if (state.poolFilter === 'oauth') return accountKind(account) === 'oauth';
  if (state.poolFilter === 'key') return accountKind(account) === 'key';
  return true;
}

/* ========================================================================== */
/* router                                                                     */
/* ========================================================================== */

const VIEWS = ['overview', 'channels', 'connect', 'accounts', 'test', 'logs', 'settings'];

function setView(name, { push = true } = {}) {
  const view = VIEWS.includes(name) ? name : 'overview';
  state.view = view;
  setMobileMenu(false);

  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.dataset.view !== view;
  }
  for (const button of document.querySelectorAll('.nav-item')) {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  if (push && location.hash !== `#${view}`) {
    history.replaceState(null, '', `#${view}`);
  }

  // Entering a view should not leave a stale focused control behind.
  const heading = document.querySelector(`#view-${view} h2`);
  if (heading) heading.setAttribute('tabindex', '-1');

  if (view === 'logs') loadLogs();
  if (view === 'test' && !state.models.length && isConfigured()) loadModels();
}

/* ========================================================================== */
/* status rendering                                                           */
/* ========================================================================== */

function renderStatus() {
  const s = state.status;
  if (!s) return;

  const configured = isConfigured();
  const running = !!s.running;
  const channels = activeChannels();
  const defaultChannel = defaultChannelStatus();
  const loginChannel = loginChannelStatus();
  const loginUser = loginChannel?.user || null;
  const canLogin = Boolean(loginChannel);
  const pool = poolStats();
  const modelCount =
    state.models.length ||
    channels.reduce((sum, channel) => sum + (Number(channel.modelCount) || 0), 0);
  const poolSignature = channels
    .map(
      (channel) =>
        `${channel.id}:${channel.accountCount || 0}:${channel.configured ? 1 : 0}:${
          channel.enabled === false ? 0 : 1
        }`
    )
    .join('|');
  if (
    state.channelPoolSignature &&
    state.channelPoolSignature !== poolSignature &&
    state.connect.length
  ) {
    renderConnectPresets();
  }
  state.channelPoolSignature = poolSignature;

  if (loginChannel && state.loginChannelId !== loginChannel.id) {
    state.loginChannelId = loginChannel.id;
  }

  // -- sidebar
  const pill = $('statusPill');
  pill.dataset.state = running ? 'running' : configured ? 'configured' : 'idle';
  $('statusText').textContent = running ? '运行中' : configured ? '已连接 · 未启动' : '未配置';
  if ($('mobileStatus')) {
    $('mobileStatus').dataset.state = pill.dataset.state;
    $('mobileStatusText').textContent = running ? '运行中' : configured ? '未启动' : '未配置';
  }
  $('navChannelCount').textContent = String(channels.length);
  if ($('navPoolCount')) $('navPoolCount').textContent = String(pool.accounts);
  $('sidebarMeta').textContent = running
    ? `${s.defaultModel || '默认模型'} · 监听中`
    : configured
      ? `${pool.accounts} 个账号 · ${pool.active} 个可用`
      : '本机运行 · 凭据仅存本地';

  $('overviewSubtitle').textContent = running
    ? `网关运行中 · ${s.defaultModel || '默认模型'}`
    : configured
      ? '渠道已就绪，可以启动网关'
      : '连接渠道，启动本地网关';

  // -- request pipeline summary
  if ($('flowChannels')) {
    $('flowChannels').textContent = channels.length
      ? `${channels.length} 个渠道 · ${channels.filter((channel) => channel.configured).length} 个就绪`
      : '尚未连接';
  }
  if ($('flowAccounts')) {
    $('flowAccounts').textContent = pool.accounts
      ? `${pool.accounts} 个账号 · ${pool.maxConcurrency} 并发`
      : '等待账号入池';
  }
  if ($('flowModels')) {
    $('flowModels').textContent = modelCount
      ? `${modelCount} 个模型`
      : configured
        ? state.modelsLoading
          ? '读取模型中…'
          : '渠道已就绪'
        : '等待模型';
  }
  if ($('flowGateway')) {
    $('flowGateway').textContent = running ? '运行中' : configured ? '待启动' : '未配置';
  }

  // -- start card
  const startState = $('startState');
  startState.textContent = running ? '运行中' : configured ? '已配置' : '等待凭据';
  startState.classList.toggle('is-on', running);

  const credState = $('credState');
  if (credState) {
    const loginConfigured = Boolean(loginChannel?.configured);
    credState.textContent = loginConfigured ? '已连接' : '待填写';
    credState.classList.toggle('is-on', loginConfigured);
  }

  // -- credentials card visibility
  const credCard = $('cardCredentials');
  if (credCard) credCard.hidden = !canLogin;

  if (!state.loginBusy && $('loginBtn')) {
    const loginBtn = $('loginBtn');
    loginBtn.disabled = false;
    loginBtn.querySelector('.btn-label').textContent = loginUser
      ? '重新授权主账号'
      : `使用 ${loginChannel?.label || '账号'} 登录`;
    $('loginHint').textContent = !loginChannel
      ? '先连接一个支持账号登录的渠道'
      : loginUser
        ? `${loginChannel.label} · ${loginUser.username || loginUser.email || ''} · 点击可重新授权`
        : `${loginChannel.label} · 浏览器授权完成后自动加入代理池`;
  }
  renderLoginAccount(loginUser);
  renderLoginChannelPicker();
  renderPool();
  renderOverviewPool();
  if ($('addAccountBtn')) $('addAccountBtn').disabled = state.loginBusy;
  if ($('accountFoot')) {
    $('accountFoot').textContent = pool.accounts
      ? `${pool.channels} 个渠道 · ${pool.accounts} 个账号 · 当前保持 ${pool.sessions} 个会话`
      : '连接渠道后，账号会自动加入这里';
  }

  // -- account summary
  const userName = s.user?.username;
  const userEmail = s.user?.email;
  if ($('userLine')) {
    $('userLine').textContent = userName
      ? userEmail && userEmail !== userName
        ? `${userName} · ${userEmail}`
        : userName
      : defaultChannel
        ? `${defaultChannel.label} · ${defaultChannel.type === 'account' ? '账号渠道' : 'API Key 渠道'}`
        : '未连接渠道';
  }

  const expiry = expiryInfo(s.token?.expiresAt);
  const expiryApplies = defaultChannel?.type === 'workbuddy' || Boolean(s.token?.expiresAt);
  if ($('expiryLine')) {
    const expiryLine = $('expiryLine');
    expiryLine.textContent = expiryApplies ? expiry.text : 'API Key 渠道';
    expiryLine.className = `expiry ${expiryApplies ? expiry.cls : ''}`.trim();
    expiryLine.title = s.token?.expiresAt
      ? `到期时间：${new Date(s.token.expiresAt).toLocaleString('zh-CN')}${s.token.hasRefreshToken ? '' : '（无刷新令牌）'}`
      : '';
  }

  // -- stats
  const stats = s.stats || {};
  $('statRequests').textContent = formatNumber(stats.requests ?? 0);
  $('statPrompt').textContent = formatNumber(stats.promptTokens ?? 0);
  $('statCompletion').textContent = formatNumber(stats.completionTokens ?? 0);
  $('statUptime').textContent = formatUptime(stats.uptimeSeconds ?? 0);
  const errors = Number(stats.errors || 0);
  $('statErrors').textContent = errors ? `${errors} 次失败` : '无失败';
  $('statErrors').className = errors ? 'is-bad' : '';
  $('statTtfb').textContent = averageTtfb();

  // -- key input
  const serverKey = s.apiKey && s.apiKey !== 'sk-wb2api-local' ? s.apiKey : '';
  const keyInput = $('keyInput');
  if (serverKey && document.activeElement !== keyInput && (!keyInput.value || keyInput.value === state.lastServerKey)) {
    keyInput.value = serverKey;
  }
  if (!serverKey && !keyInput.value) keyInput.placeholder = '留空则自动生成';
  state.lastServerKey = serverKey;

  // -- model select
  const modelSelect = state.modelSelect;
  if (modelSelect) {
    if (
      s.defaultModel &&
      !state.modelTouched &&
      modelSelect.hasValue(s.defaultModel) &&
      modelSelect.getValue() !== s.defaultModel
    ) {
      modelSelect.setValue(s.defaultModel);
      updateModelDescription();
      state.contextTouched = false;
      updateContextOptions();
    }
    modelSelect.setDisabled(!configured || !state.models.length);
  }

  const contextSelect = state.contextSelect;
  if (contextSelect) {
    if (!state.contextTouched && state.models.length) {
      const selected = state.models.find((item) => item.id === (modelSelect?.getValue() || ''));
      const contextKey = selected ? selected.root || selected.id : '';
      const settings = contextWindowForModel(selected);
      const configuredContext = Number(settings.overrides?.[contextKey] ?? settings.default ?? 0);
      if (
        configuredContext &&
        contextSelect.getValue() !== String(configuredContext) &&
        contextSelect.hasValue(String(configuredContext))
      ) {
        contextSelect.setValue(String(configuredContext));
        updateContextDescription();
      }
    }
    contextSelect.setDisabled(!configured || !state.models.length || !contextSelect.hasOptions());
  }

  $('modelsBtn').disabled = !configured;
  $('startBtn').disabled = !configured || $('startBtn').classList.contains('is-busy');
  $('startBtn').querySelector('.btn-label').textContent = running ? '更新并应用' : '启动网关';

  // -- output panel
  $('cardOutput').classList.toggle('is-live', running);
  $('outputEmpty').hidden = running;
  $('outputLive').hidden = !running;

  if (running) {
    $('baseUrlText').textContent = s.baseUrl || '—';
    $('apiKeyText').textContent = s.apiKey || '—';
    $('readyMeta').textContent = `${defaultChannel?.label || '默认渠道'} · ${s.defaultModel || '默认模型'}`;
    renderSnippet();
  }

  renderChannels(channels);
  renderHealth(channels);
  renderSettings();
  loadConnectPresets();
}

function averageTtfb() {
  const rows = state.logs.filter((row) => row.ttfbMs != null);
  if (!rows.length) return '—';
  const avg = rows.reduce((sum, row) => sum + row.ttfbMs, 0) / rows.length;
  return avg >= 1000 ? `${(avg / 1000).toFixed(1)}s` : `${Math.round(avg)}ms`;
}

function renderHealth(channels) {
  const grid = $('healthGrid');
  if (!grid) return;
  clear(grid);

  const enabled = channels.filter((channel) => channel.enabled !== false);
  const ready = enabled.filter((channel) => channel.configured);
  $('healthMeta').textContent = channels.length
    ? `${ready.length}/${enabled.length} 个启用渠道已就绪`
    : '还没有渠道';

  if (!channels.length) {
    grid.appendChild(el('div', 'empty-state', '到「连接」页添加第一个渠道'));
    return;
  }

  const defaultId = defaultChannelStatus()?.id;
  for (const channel of channels) {
    const item = el(
      'button',
      `health-item${channel.enabled === false ? ' is-off' : ''}`
    );
    item.type = 'button';
    item.addEventListener('click', () => setView('channels'));

    const top = el('div', 'health-top');
    const dot = el('span', 'channel-dot');
    if (channel.enabled !== false && channel.configured) dot.classList.add('is-on');
    else if (channel.enabled !== false) dot.classList.add('is-warn');
    top.appendChild(dot);
    top.appendChild(el('strong', '', channel.label || channel.id));
    if (channel.id === defaultId) top.appendChild(el('span', 'channel-badge is-default', '默认'));
    item.appendChild(top);

    const meta = [];
    if (channel.modelCount) meta.push(`${channel.modelCount} 模型`);
    if (channel.accountCount) meta.push(`${channel.accountCount} 账号`);
    if (channel.enabled === false) meta.push('已停用');
    else if (!channel.configured) meta.push('待配置');
    item.appendChild(el('span', 'health-meta', meta.join(' · ') || '—'));
    grid.appendChild(item);
  }
}

function renderSnippet() {
  const s = state.status;
  if (!s) return;
  const base = s.baseUrl || `${location.origin}/v1`;
  const key = s.apiKey || 'sk-wb-...';
  const model = s.defaultModel || 'deepseek-v4.1-flash';
  $('snippetText').textContent =
    `curl ${base}/chat/completions \\\n` +
    `  -H "Authorization: Bearer ${key}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}],"stream":true}'`;
}

async function refreshStatus({ silent = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    state.status = await api('/admin/status');
    state.statusErrorShown = false;
    renderStatus();
    if (!silent) await loadLogs();
  } catch (err) {
    if (!state.statusErrorShown) {
      state.statusErrorShown = true;
      $('statusPill').dataset.state = 'error';
      $('statusText').textContent = '连接失败';
      toast(`无法读取状态：${err.message}`, 'error');
    }
  } finally {
    state.refreshing = false;
  }
}

/* ========================================================================== */
/* models                                                                     */
/* ========================================================================== */

function renderModels() {
  const select = state.modelSelect;
  if (!select) return;

  if (!state.models.length) {
    select.setOptions([]);
    select.setDisabled(true);
    return;
  }

  select.setOptions(
    state.models.map((model) => ({
      value: model.id,
      label: model.name && model.name !== model.id ? model.name : model.id,
      description: model.channel ? `${model.channel} · ${model.upstream_id || model.id}` : '',
      searchText: `${model.id} ${model.name || ''} ${model.root || ''} ${model.channel || ''}`
    }))
  );

  const preferred = state.status?.defaultModel;
  if (!state.modelTouched && preferred && select.hasValue(preferred)) {
    select.setValue(preferred);
  }

  if (state.status) {
    const ready = isConfigured();
    select.setDisabled(!ready);
    $('modelsBtn').disabled = !ready;
  }

  renderModelChips();
  updateModelDescription();
  updateContextOptions();
  renderTestModels();
}

function renderModelChips() {
  const row = $('modelChips');
  clear(row);
  const popular = [
    'deepseek-v4.1-flash',
    'deepseek-v4.1-flash-sg',
    'kimi-k3',
    'glm-5.3-flash',
    'gpt-5.6-luna'
  ];
  const select = state.modelSelect;
  const current = select?.getValue();
  for (const wanted of popular) {
    const model = state.models.find(
      (item) => item.upstream_id === wanted || item.id === wanted || item.id.endsWith(`/${wanted}`)
    );
    if (!model) continue;
    const button = el('button', `chip${current === model.id ? ' is-active' : ''}`);
    button.type = 'button';
    button.textContent = model.channel ? `${model.channel}/${wanted}` : wanted;
    button.title = model.name || model.id;
    button.addEventListener('click', () => {
      if (!select) return;
      select.setValue(model.id);
      state.modelTouched = true;
      state.contextTouched = false;
      updateModelDescription();
      updateContextOptions();
      renderModelChips();
    });
    row.appendChild(button);
  }
}

function updateModelDescription() {
  const model = state.models.find((item) => item.id === state.modelSelect?.getValue());
  const desc = $('modelDesc');
  if (!model) {
    desc.textContent = isConfigured() ? '没有可用模型，检查渠道状态' : '连接渠道后加载模型列表';
    return;
  }
  const parts = [];
  if (model.channel_label) parts.push(model.channel_label);
  if (model.context_length) parts.push(`${formatContext(model.context_length)} 上下文`);
  if (model.max_output_tokens) parts.push(`${formatNumber(model.max_output_tokens)} 输出`);
  const caps = model.capabilities || {};
  const features = [];
  if (caps.vision) features.push('图片');
  if (caps.tools) features.push('工具');
  if (caps.reasoning) features.push('推理');
  if (features.length) parts.push(features.join(' / '));
  desc.textContent = parts.length ? parts.join(' · ') : '模型信息加载中';
}

function updateContextOptions() {
  const select = state.contextSelect;
  if (!select) return;
  const previous = Number(select.getValue()) || 0;
  const model = state.models.find((item) => item.id === state.modelSelect?.getValue());

  if (!model) {
    select.setOptions([]);
    select.setDisabled(true);
    updateContextDescription();
    return;
  }

  const supported = (model.supported_context_lengths || [])
    .map(Number)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const values = supported.length
    ? supported
    : model.max_context_length
      ? [Number(model.max_context_length)]
      : [];

  if (!values.length) {
    select.setOptions([]);
    select.setDisabled(true);
    updateContextDescription();
    return;
  }

  select.setOptions(values.map((value) => ({ value: String(value), label: formatContext(value) })));

  const configuredWindow = contextWindowForModel(model);
  const contextKey = model.root || model.id;
  const configured = Number(configuredWindow.overrides?.[contextKey] ?? configuredWindow.default ?? 0);
  const desired =
    state.contextTouched && select.hasValue(String(previous))
      ? String(previous)
      : select.hasValue(String(configured))
        ? String(configured)
        : String(values[values.length - 1]);

  select.setValue(desired);
  select.setDisabled(!isConfigured());
  updateContextDescription();
}

function updateContextDescription() {
  const desc = $('contextDesc');
  const model = state.models.find((item) => item.id === state.modelSelect?.getValue());
  const selected = Number(state.contextSelect?.getValue()) || 0;
  if (!model || !selected) {
    desc.textContent = '向客户端声明的上限，网关不会截断请求';
    return;
  }
  const max = Number(model.max_context_length || model.context_length || 0);
  desc.textContent = `声明 ${formatContext(selected)} · 模型上限 ${formatContext(max)}`;
}

async function loadModels(force = false) {
  const button = $('modelsBtn');
  state.modelsLoading = true;
  setBusy(button, true);
  try {
    const data = await api('/admin/models');
    state.models = Array.isArray(data.data) ? data.data : [];
    renderModels();
    if ($('flowModels') && state.models.length) {
      $('flowModels').textContent = `${state.models.length} 个模型`;
    }
    if (force) toast(`已加载 ${state.models.length} 个模型`, 'success');
  } catch (err) {
    toast(`模型列表加载失败：${err.message}`, 'error');
  } finally {
    state.modelsLoading = false;
    setBusy(button, false);
    button.disabled = !isConfigured();
  }
}

function renderTestChannels() {
  const select = state.testChannelSelect;
  if (!select) return;

  const channelIds = [...new Set(state.models.map((model) => model.channel).filter(Boolean))];
  if (!channelIds.length) {
    select.setOptions([{ value: '', label: '全部渠道（0）' }]);
    select.setValue('');
    select.setDisabled(true);
    state.testChannel = null;
    return;
  }

  const options = [{ value: '', label: `全部渠道 · ${state.models.length}` }];
  for (const id of channelIds) {
    const models = state.models.filter((model) => model.channel === id);
    const label =
      models[0]?.channel_label || channelById(id)?.label || id;
    options.push({
      value: id,
      label: `${label} · ${models.length}`
    });
  }

  select.setOptions(options);
  select.setDisabled(false);

  const valid = state.testChannel !== null && options.some((option) => option.value === state.testChannel);
  if (!valid) {
    const preferredChannel = state.models.find(
      (model) => model.id === state.status?.defaultModel
    )?.channel;
    state.testChannel =
      preferredChannel && channelIds.includes(preferredChannel)
        ? preferredChannel
        : channelIds[0];
  }
  select.setValue(state.testChannel || '');
}

function renderTestModels() {
  const select = state.testModelSelect;
  if (!select) return;

  renderTestChannels();

  if (!state.models.length) {
    select.setOptions([]);
    select.setDisabled(true);
    if ($('testModelCount')) $('testModelCount').textContent = '0 个模型';
    if ($('testModelHint')) $('testModelHint').textContent = '没有可用模型，请先连接渠道或刷新模型列表。';
    if ($('runTestBtn')) $('runTestBtn').disabled = true;
    return;
  }

  const allChannels = [...new Set(state.models.map((model) => model.channel).filter(Boolean))];
  const channelOrder = new Map(allChannels.map((id, index) => [id, index]));
  const models = (
    state.testChannel
      ? state.models.filter((model) => model.channel === state.testChannel)
      : state.models.slice()
  ).sort((a, b) => {
    const orderA = channelOrder.get(a.channel) ?? 999;
    const orderB = channelOrder.get(b.channel) ?? 999;
    if (orderA !== orderB) return orderA - orderB;
    return a.id.localeCompare(b.id);
  });

  const channelLabel = state.testChannel
    ? models[0]?.channel_label || channelById(state.testChannel)?.label || state.testChannel
    : `${allChannels.length} 个渠道`;
  if ($('testModelCount')) {
    $('testModelCount').textContent = `${models.length} 个模型 · ${channelLabel}`;
  }

  if (!models.length) {
    select.setOptions([]);
    select.setDisabled(true);
    if ($('testModelHint')) $('testModelHint').textContent = '该渠道没有可用模型。';
    if ($('runTestBtn')) $('runTestBtn').disabled = true;
    return;
  }

  select.setOptions(
    models.map((model) => ({
      value: model.id,
      label: model.id,
      group: model.channel_label || model.channel || '其他渠道',
      description: [
        model.name || '',
        model.context_length || model.context_window
          ? `上下文 ${formatContext(model.context_length || model.context_window)}`
          : ''
      ]
        .filter(Boolean)
        .join(' · '),
      searchText: `${model.id} ${model.name || ''} ${model.upstream_id || ''} ${model.channel || ''}`
    }))
  );

  if (!select.getValue() || !select.hasValue(select.getValue())) {
    const preferred = state.status?.defaultModel;
    select.setValue(
      preferred && select.hasValue(preferred) ? preferred : models[0].id
    );
  }
  select.setDisabled(false);
  if ($('runTestBtn')) $('runTestBtn').disabled = state.testBusy;
  updateTestModelHint();
}

function updateTestModelHint() {
  const node = $('testModelHint');
  if (!node) return;
  const id = state.testModelSelect?.getValue() || '';
  const model = state.models.find((item) => item.id === id);
  if (!model) {
    node.textContent = '请选择一个模型';
    return;
  }
  const context = model.context_length || model.context_window || model.max_input_tokens;
  node.textContent = [
    model.channel_label || model.channel || '',
    `上游 ${model.upstream_id || model.id}`,
    context ? `上下文 ${formatContext(context)}` : ''
  ]
    .filter(Boolean)
    .join(' · ');
}

function setTestStatus(text, kind = '') {
  const node = $('testStatus');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('is-on', kind === 'ok');
  node.classList.toggle('is-warn', kind === 'warn');
  node.classList.toggle('is-error', kind === 'error');
}

function setTestEmpty(title, text, kind = '') {
  const empty = $('testOutputEmpty');
  if (!empty) return;
  empty.hidden = false;
  empty.className = `test-empty${kind ? ` is-${kind}` : ''}`;
  if ($('testEmptyTitle')) $('testEmptyTitle').textContent = title;
  if ($('testEmptyText')) $('testEmptyText').textContent = text;
  if ($('testOutputWrap')) $('testOutputWrap').hidden = true;
}

function renderTestResult(data, wallMs) {
  const content = String(data.content || '').trim();
  const output = content || (data.toolCalls ? '模型返回了工具调用，见下方原始响应。' : '（无文本输出）');

  state.lastTestOutput = output;
  if ($('testOutputWrap')) $('testOutputWrap').hidden = false;
  if ($('testOutputEmpty')) $('testOutputEmpty').hidden = true;
  if ($('testError')) {
    $('testError').hidden = true;
    $('testError').textContent = '';
  }
  if ($('testOutput')) $('testOutput').textContent = output;
  if ($('testOutputHint')) {
    $('testOutputHint').textContent = `${data.channelLabel || data.channel || '渠道'} · ${
      data.account || '账号'
    } · 完成于 ${new Date().toLocaleTimeString('zh-CN')}`;
  }

  const meta = $('testMeta');
  if (meta) {
    clear(meta);
    const usage = data.usage || {};
    const chips = [
      data.channelLabel || data.channel,
      data.account,
      data.upstreamModel && data.upstreamModel !== data.requestedModel
        ? `上游 ${data.upstreamModel}`
        : '',
      data.ttfbMs != null ? `首字 ${data.ttfbMs}ms` : '',
      data.durationMs != null ? `耗时 ${data.durationMs}ms` : '',
      usage.prompt_tokens != null || usage.completion_tokens != null
        ? `Tokens ${usage.prompt_tokens ?? '?'}/${usage.completion_tokens ?? '?'}`
        : '',
      data.finishReason ? `finish ${data.finishReason}` : ''
    ].filter(Boolean);
    for (const chip of chips) meta.appendChild(el('span', 'chip', chip));
  }

  const reasoningWrap = $('testReasoningWrap');
  if (reasoningWrap) {
    const reasoning = String(data.reasoning || '').trim();
    reasoningWrap.hidden = !reasoning;
    if (reasoning && $('testReasoning')) $('testReasoning').textContent = reasoning;
  }

  if ($('testRaw')) {
    $('testRaw').textContent = JSON.stringify(data.completion || data, null, 2);
  }
  if ($('copyTestOutputBtn')) $('copyTestOutputBtn').disabled = false;

  const status = data.durationMs != null ? `成功 · ${data.durationMs}ms` : '成功';
  setTestStatus(status, 'ok');
  setMsg($('testMsg'), `测试完成（${Math.round(wallMs)}ms）`, 'ok');
}

function renderTestError(message) {
  state.lastTestOutput = '';
  if ($('copyTestOutputBtn')) $('copyTestOutputBtn').disabled = true;
  setTestEmpty('测试失败', message, 'error');
  if ($('testOutputHint')) $('testOutputHint').textContent = '请求没有完成';
  setTestStatus('失败', 'error');
  setMsg($('testMsg'), message, 'error');
}

async function runModelTest() {
  if (state.testBusy) return;
  const model = state.testModelSelect?.getValue() || '';
  const input = $('testInput')?.value.trim() || '';
  if (!model) {
    toast('请先选择测试模型', 'warn');
    return;
  }
  if (!input) {
    toast('请输入要发送的内容', 'warn');
    return;
  }

  const maxTokens = Number($('testMaxTokens')?.value);
  const temperatureRaw = $('testTemperature')?.value.trim() || '';
  const temperature = temperatureRaw === '' ? undefined : Number(temperatureRaw);
  const system = $('testSystem')?.value.trim() || '';

  state.testBusy = true;
  const button = $('runTestBtn');
  setBusy(button, true);
  setTestStatus('请求中', 'warn');
  setTestEmpty('正在测试…', `等待 ${model} 返回，复杂模型可能需要几秒。`, 'pending');
  setMsg($('testMsg'), '正在调用上游…', 'warn');
  if ($('testOutputHint')) $('testOutputHint').textContent = '等待上游返回';

  const started = performance.now();
  try {
    const data = await api(
      '/admin/test-chat',
      {
        method: 'POST',
        body: JSON.stringify({
          model,
          input,
          system,
          maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : undefined,
          temperature:
            Number.isFinite(temperature) && temperature >= 0 && temperature <= 2
              ? temperature
              : undefined
        }),
        signal: AbortSignal.timeout(180000)
      }
    );
    renderTestResult(data, performance.now() - started);
    await refreshStatus({ silent: true });
    await loadLogs();
  } catch (err) {
    renderTestError(err.message);
    toast(`测试失败：${err.message}`, 'error');
  } finally {
    state.testBusy = false;
    setBusy(button, false);
    if (button) button.disabled = !state.models.length;
    if ($('runTestBtn')) $('runTestBtn').disabled = !state.models.length;
  }
}

/* ========================================================================== */
/* channels                                                                   */
/* ========================================================================== */

function channelTypeLabel(channel) {
  if (channel.type === 'workbuddy') return 'WorkBuddy';
  if (channel.type === 'codebuddy') return 'CodeBuddy';
  if (channel.type === 'account') return '账号渠道';
  if (channel.type === 'openai-compatible') return channel.options?.preset ? '预设' : 'OpenAI 兼容';
  return channel.type;
}

function channelMatches(channel, query) {
  if (!query) return true;
  const haystack = [
    channel.id,
    channel.label,
    channel.type,
    channel.options?.preset || '',
    ...(channel.options?.models || [])
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function channelPassesFilter(channel, filter) {
  if (filter === 'all') return true;
  if (filter === 'ready') return channel.configured && channel.enabled !== false;
  if (filter === 'pending') return !channel.configured;
  if (filter === 'oauth') return Boolean(channel.capabilities?.oauth);
  return true;
}

function renderChannels(channels) {
  const list = $('channelList');
  if (!list) return;

  const defaultId = defaultChannelStatus()?.id;
  const query = state.channelQuery.trim().toLowerCase();
  const visible = channels.filter(
    (c) => channelPassesFilter(c, state.channelFilter) && channelMatches(c, query)
  );

  const totalAccounts = channels.reduce((sum, channel) => sum + accountsOf(channel).length, 0);
  const totalModels = channels.reduce((sum, channel) => sum + (Number(channel.modelCount) || 0), 0);
  if ($('channelTotal')) $('channelTotal').textContent = String(channels.length);
  if ($('channelReady')) {
    $('channelReady').textContent = String(
      channels.filter((channel) => channel.configured && channel.enabled !== false).length
    );
  }
  if ($('channelAccounts')) $('channelAccounts').textContent = String(totalAccounts);
  if ($('channelModels')) $('channelModels').textContent = String(totalModels);

  clear(list);

  if (!channels.length) {
    const empty = el('div', 'card empty-state');
    empty.appendChild(el('strong', '', '还没有渠道'));
    empty.appendChild(el('span', '', '连接 WorkBuddy，或添加一个 OpenAI 兼容上游。'));
    const button = el('button', 'btn secondary mini', '去连接');
    button.type = 'button';
    button.addEventListener('click', () => setView('connect'));
    empty.appendChild(button);
    list.appendChild(empty);
    return;
  }

  if (!visible.length) {
    list.appendChild(el('div', 'card empty-state', '没有符合条件的渠道'));
    return;
  }

  for (const channel of visible) {
    const accounts = accountsOf(channel);
    const pooled = channel.configured && accounts.length > 0;
    const isOpen = state.openChannels.has(channel.id);
    const card = el(
      'div',
      `channel-card${channel.enabled === false ? ' is-disabled' : ''}${pooled ? ' is-pooled' : ''}${
        isOpen ? ' is-open' : ''
      }`
    );

    const dot = el('span', 'channel-dot');
    if (channel.enabled !== false && channel.configured) dot.classList.add('is-on');
    else if (channel.enabled !== false) dot.classList.add('is-warn');

    const main = el('div', 'channel-main');
    const title = el('div', 'channel-title');
    title.appendChild(providerMark(channel.id, channel.label, 'xs'));
    title.appendChild(el('strong', '', channel.label || channel.id));

    if (channel.id === defaultId) title.appendChild(el('span', 'channel-badge is-default', '默认'));
    if (channel.capabilities?.oauth) title.appendChild(el('span', 'channel-badge is-oauth', 'OAuth'));
    title.appendChild(el('span', 'channel-badge', channelTypeLabel(channel)));
    if (pooled) {
      title.appendChild(el('span', 'channel-badge is-pooled', '已入池'));
    } else if (channel.enabled !== false) {
      title.appendChild(el('span', 'channel-badge is-pending', '未入池'));
    }
    main.appendChild(title);

    const parts = [];
    if (accounts.length) parts.push(`${accounts.length} 个账号`);
    if (channel.modelCount) parts.push(`${channel.modelCount} 个模型`);
    parts.push(channel.configured ? '已配置' : '待配置');

    // Show the credential state the way the channel actually authenticates.
    if (channel.type === 'account') {
      parts.push(channel.options?.hasToken ? 'OAuth 已授权' : '待授权');
    } else if (channel.type === 'openai-compatible') {
      parts.push(channel.options?.hasKey ? 'Key 已保存' : '免密 / 无 Key');
    }
    if (channel.routing?.sessions) parts.push(`${channel.routing.sessions} 个会话`);
    main.appendChild(el('div', 'channel-meta', parts.join(' · ')));
    if (channel.options?.baseUrl) {
      main.appendChild(el('div', 'channel-url', channel.options.baseUrl));
    }

    const preset = (state.status?.connect || []).find((entry) => entry.id === channel.options?.preset);
    if (preset?.note) main.appendChild(el('div', 'channel-hint', preset.note));

    if (accounts.length) {
      const chips = el('div', 'channel-accounts');
      for (const account of accounts.slice(0, 3)) {
        const chip = el('span', 'mini-account');
        chip.appendChild(
          el('span', 'avatar xs', String(accountName(account)).slice(0, 1).toUpperCase())
        );
        chip.appendChild(el('span', '', accountName(account)));
        chips.appendChild(chip);
      }
      if (accounts.length > 3) {
        chips.appendChild(el('span', 'mini-account more', `+${accounts.length - 3}`));
      }
      main.appendChild(chips);
    }

    const actions = el('div', 'channel-actions');

    if (channel.type === 'account' && channel.capabilities?.oauth) {
      const auth = el('button', 'ghost mini', channel.configured ? '重新授权' : '去授权');
      auth.type = 'button';
      auth.addEventListener('click', () => openConnectFor(channel));
      actions.appendChild(auth);
    } else if (channel.capabilities?.login) {
      const add = el('button', 'ghost mini', '添加账号');
      add.type = 'button';
      add.disabled = state.loginBusy;
      add.addEventListener('click', () =>
        startLogin({ channel: channel.id, createNew: true, accountId: 'primary' })
      );
      actions.appendChild(add);
    } else if (channel.type === 'openai-compatible') {
      const key = el('button', 'ghost mini', '更新 Key');
      key.type = 'button';
      key.addEventListener('click', () => editChannelKey(channel));
      actions.appendChild(key);
    }

    const detail = el('button', 'ghost mini', isOpen ? '收起' : '详情');
    detail.type = 'button';
    detail.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    actions.appendChild(detail);

    const test = el('button', 'ghost mini', '测试');
    test.type = 'button';
    test.addEventListener('click', () => testChannel(channel.id));
    actions.appendChild(test);

    const toggle = el('button', 'ghost mini', channel.enabled === false ? '启用' : '停用');
    toggle.type = 'button';
    toggle.addEventListener('click', () => toggleChannel(channel.id, channel.enabled === false));
    actions.appendChild(toggle);

    if (channels.length > 1) {
      const remove = el('button', 'ghost mini danger', '删除');
      remove.type = 'button';
      remove.addEventListener('click', () => removeChannel(channel.id));
      actions.appendChild(remove);
    }

    card.append(dot, main, actions);

    // -- expandable detail
    const panel = el('div', 'channel-detail');
    panel.hidden = !isOpen;
    panel.appendChild(buildChannelDetail(channel));
    card.appendChild(panel);

    detail.addEventListener('click', () => {
      const open = !state.openChannels.has(channel.id);
      if (open) state.openChannels.add(channel.id);
      else state.openChannels.delete(channel.id);
      panel.hidden = !open;
      detail.setAttribute('aria-expanded', open ? 'true' : 'false');
      detail.textContent = open ? '收起' : '详情';
      card.classList.toggle('is-open', open);
    });

    list.appendChild(card);
  }
}

/** Detail body: base URL, credential state, models and live accounts. */
function buildChannelDetail(channel) {
  const wrap = el('div', 'detail-body');

  const rows = [
    ['渠道 ID', channel.id],
    ['类型', channelTypeLabel(channel)],
    ['Base URL', channel.options?.baseUrl || '—']
  ];
  if (channel.type === 'openai-compatible') {
    rows.push(['凭据', channel.options?.hasKey ? `Key ${channel.options.maskedKey || '已保存'}` : '无（免密或本机）']);
  }
  if (channel.type === 'account') {
    rows.push(['凭据', channel.options?.hasToken ? 'OAuth 已授权' : '尚未授权']);
    if (channel.options?.oauth) rows.push(['授权方式', channel.options.oauth]);
  }
  if (channel.models?.default) rows.push(['渠道默认模型', channel.models.default]);

  const list = el('dl', 'info-list');
  for (const [label, value] of rows) {
    const row = el('div');
    row.appendChild(el('dt', '', label));
    row.appendChild(el('dd', '', String(value)));
    list.appendChild(row);
  }
  wrap.appendChild(list);

  const toolbar = el('div', 'detail-actions');
  const poolButton = el('button', 'ghost mini', '在代理池中管理');
  poolButton.type = 'button';
  poolButton.addEventListener('click', () => {
    setView('accounts');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  toolbar.appendChild(poolButton);
  if (channel.type === 'openai-compatible') {
    const keyButton = el('button', 'ghost mini', '更新 API Key');
    keyButton.type = 'button';
    keyButton.addEventListener('click', () => editChannelKey(channel));
    toolbar.appendChild(keyButton);
  }
  wrap.appendChild(toolbar);

  const accounts = Array.isArray(channel.accounts) ? channel.accounts : [];
  if (accounts.length) {
    wrap.appendChild(el('div', 'detail-heading', `账号（${accounts.length}）`));
    const box = el('div', 'account-list');
    for (const account of accounts) {
      const row = el('div', `account-row${account.enabled === false ? ' is-disabled' : ''}`);
      row.appendChild(
        el('div', 'avatar', String(account.username || account.email || account.label || '?').slice(0, 1).toUpperCase())
      );
      const who = el('div', 'who');
      who.appendChild(el('span', 'name', account.username || account.label || account.id));
      const meta = [];
      meta.push(`并发 ${account.load ?? 0}/${account.maxConcurrency ?? 1}`);
      if (account.sessions) meta.push(`会话 ${account.sessions}`);
      if (account.expiresAt) meta.push(`到期 ${new Date(account.expiresAt).toLocaleDateString('zh-CN')}`);
      if (account.coolingDown) meta.push('冷却中');
      who.appendChild(el('span', 'meta', meta.join(' · ')));
      row.appendChild(who);
      row.appendChild(el('span', 'channel-badge', account.enabled === false ? '已停用' : '启用'));
      box.appendChild(row);
    }
    wrap.appendChild(box);
  }

  const aliases = Object.entries(channel.models?.aliases || {});
  if (aliases.length) {
    wrap.appendChild(el('div', 'detail-heading', `别名（${aliases.length}）`));
    const chips = el('div', 'chip-row');
    for (const [from, to] of aliases) chips.appendChild(el('span', 'chip', `${from} → ${to}`));
    wrap.appendChild(chips);
  }

  return wrap;
}

async function testChannel(id) {
  try {
    const data = await api('/admin/channels/test', {
      method: 'POST',
      body: JSON.stringify({ id })
    });
    toast(data.message || `${id} 可用`, 'success');
    await refreshStatus({ silent: true });
    await loadModels();
  } catch (err) {
    toast(`渠道不可用：${err.message}`, 'error');
  }
}

async function toggleChannel(id, enabled) {
  try {
    await api('/admin/channels/toggle', {
      method: 'POST',
      body: JSON.stringify({ id, enabled })
    });
    toast(enabled ? '渠道已启用' : '渠道已停用', 'success');
    await refreshStatus({ silent: true });
    await loadModels();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeChannel(id) {
  if (!window.confirm(`确定删除渠道 ${id}？该渠道的账号与模型配置会一并移除。`)) return;
  try {
    await api('/admin/channels/remove', {
      method: 'POST',
      body: JSON.stringify({ id })
    });
    toast('渠道已删除', 'success');
    await refreshStatus({ silent: true });
    await loadModels();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function createChannel() {
  const id = $('channelIdInput').value.trim();
  const baseUrl = $('channelBaseInput').value.trim();
  if (!id || !baseUrl) {
    toast('请填写渠道 ID 与 Base URL', 'error');
    return;
  }

  const button = $('createChannelBtn');
  setBusy(button, true);
  setMsg($('channelMsg'), '正在添加渠道…', 'warn');

  try {
    const data = await api('/admin/channels/create', {
      method: 'POST',
      body: JSON.stringify({
        id,
        type: 'openai-compatible',
        label: $('channelLabelInput').value.trim() || id,
        baseUrl,
        apiKey: $('channelKeyInput').value.trim(),
        models: $('channelModelsInput').value
      })
    });
    setMsg($('channelMsg'), `渠道 ${data.channel.label} 已添加`, 'ok');
    toast('渠道已添加', 'success');
    $('channelIdInput').value = '';
    $('channelLabelInput').value = '';
    $('channelBaseInput').value = '';
    $('channelKeyInput').value = '';
    $('channelModelsInput').value = '';
    $('channelAdd').open = false;
    await refreshStatus({ silent: true });
    await loadModels();
  } catch (err) {
    setMsg($('channelMsg'), err.message, 'error');
    toast(err.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

/* ========================================================================== */
/* connect wizard                                                             */
/* ========================================================================== */

const STRATEGY_LABEL = {
  oauth: '一键授权',
  'open-key': '需 API Key',
  keyless: '免密'
};

const STRATEGY_GROUP = [
  {
    id: 'oauth',
    title: '账号渠道',
    hint: '官方授权，点一下即可'
  },
  {
    id: 'open-key',
    title: 'API Key 渠道',
    hint: '复制 Key 后自动捕获'
  }
];

/** Human-readable authorization kind for the fact sheet. */
function OAuthKindLabel(oauth) {
  return (
    {
      openrouter: 'OAuth PKCE + 本机回调',
      workbuddy: '桌面端授权页轮询',
      cline: 'WorkOS 设备码',
      qoder: 'PKCE 设备码',
      'gemini-code-assist': 'Google OAuth + 本机回调',
      trae: 'PKCE + 本机回调',
      raccoon: '微信扫码',
      zcode: '服务端中介设备流',
      'minimax-code': '设备码 + PKCE',
      loomy: '短信验证码',
      lobsterai: '授权码 + 本机回调'
    }[oauth] || '官方授权'
  );
}

function connectInfoFor(id) {
  return state.connect.find((entry) => entry.id === id) || null;
}

function renderConnectPresets() {
  const box = $('connectPresets');
  if (!box) return;
  clear(box);

  const query = state.connectQuery.trim().toLowerCase();

  for (const group of STRATEGY_GROUP) {
    const items = state.connect.filter((entry) => {
      if (entry.strategy !== group.id) return false;
      if (!query) return true;
      return `${entry.id} ${entry.name} ${entry.baseUrl}`.toLowerCase().includes(query);
    });
    if (!items.length) continue;

    const section = el('div', 'connect-group');
    const title = el('div', 'connect-group-title');
    title.appendChild(document.createTextNode(group.title));
    title.appendChild(el('em', '', `· ${group.hint} · ${items.length}`));
    section.appendChild(title);

    const grid = el('div', 'connect-grid');
    for (const preset of items) {
      const connected = activeChannels().find(
        (channel) => channel.id === preset.id || channel.options?.preset === preset.id
      );
      const button = el(`button`, `connect-item${preset.id === state.connectSelected ? ' is-active' : ''}${connected ? ' is-connected' : ''}`);
      button.type = 'button';
      button.dataset.preset = preset.id;
      const head = el('div', 'connect-item-head');
      head.appendChild(providerMark(preset.id, preset.name, 'xs'));
      head.appendChild(el('strong', '', preset.name));
      button.appendChild(head);
      const label = STRATEGY_LABEL[preset.strategy] || preset.strategy;
      button.appendChild(el('span', preset.strategy === 'oauth' ? 'is-oauth-label' : '', label));
      if (connected) {
        button.appendChild(
          el(
            'span',
            'connect-item-badge',
            connected.accountCount ? `已入池 · ${connected.accountCount}` : '已连接'
          )
        );
      }
      button.addEventListener('click', () => selectConnect(preset.id));
      grid.appendChild(button);
    }
    section.appendChild(grid);
    box.appendChild(section);
  }

  if (!box.childElementCount) {
    box.appendChild(el('div', 'card empty-state', '没有匹配的服务商'));
  }
}

function selectConnect(id) {
  stopOauthPolling();
  stopClipboardWatch();
  state.connectSelected = id;
  state.clipboardSignature = '';
  state.oauthState = '';
  state.oauthProvider = '';
  state.smsState = '';

  const info = connectInfoFor(id);
  const panel = $('connectPanel');

  renderConnectPresets();
  setConnectResult('', null);
  markWizardStep(1);

  if (!info) {
    panel.hidden = true;
    $('connectState').textContent = '待选择';
    return;
  }

  panel.hidden = false;
  $('connectName').textContent = info.name;
  $('connectNote').textContent = info.note || '';
  $('connectSubtitle').textContent =
    info.strategy === 'oauth'
      ? '账号渠道 · 官方授权'
      : info.strategy === 'keyless'
        ? '免密渠道 · 无需账号或 Key'
        : 'API Key 渠道 · 复制后自动捕获';

  // A compact fact sheet keeps the panel from looking empty and answers the
  // questions people actually ask before authorizing.
  const facts = $('connectFacts');
  if (facts) {
    clear(facts);
    const rows = [
      ['端点', info.baseUrl || '—'],
      ['授权方式', info.strategy === 'oauth' ? OAuthKindLabel(info.oauth) : STRATEGY_LABEL[info.strategy]],
      ['需要 Key', info.apiKeyRequired ? '是' : '否']
    ];
    if (info.suggestedModels?.length) {
      rows.push(['示例模型', info.suggestedModels.slice(0, 3).join(' · ')]);
    }
    for (const [label, value] of rows) {
      const row = el('div', 'fact');
      row.appendChild(el('span', '', label));
      row.appendChild(el('strong', '', value));
      facts.appendChild(row);
    }
  }

  const strategy = $('connectStrategy');
  strategy.textContent = STRATEGY_LABEL[info.strategy] || info.strategy;
  strategy.className = `connect-strategy${info.strategy === 'oauth' ? ' is-oauth' : ''}`;

  const stateLabel = $('connectState');
  stateLabel.textContent =
    info.strategy === 'oauth' ? '可一键授权' : info.strategy === 'keyless' ? '免密' : '需 Key';
  stateLabel.classList.toggle('is-on', info.strategy === 'oauth');

  $('connectStepOauth').hidden = info.strategy !== 'oauth';
  $('connectStepKey').hidden = info.strategy !== 'open-key';
  $('connectStepKeyless').hidden = info.strategy !== 'keyless';

  $('oauthState').hidden = true;
  $('connectDevice').hidden = true;
  $('connectQr').hidden = true;
  $('connectSms').hidden = true;
  $('smsCodeField').hidden = true;
  $('connectKeyInput').value = '';
  $('detectLocalBtn').hidden = !info.local;
  $('openKeyPageBtn').hidden = !info.keyUrl;

  if (info.strategy === 'oauth') {
    const existing = activeChannels().find((channel) => channel.id === info.id);
    const appendAccount =
      info.oauth === 'workbuddy' && Boolean(existing && accountsOf(existing).length);
    $('oauthHint').textContent = appendAccount
      ? '当前渠道已有账号：这里会追加一个新账号，不会覆盖现有账号。'
      : info.note || '点「一键授权」后在浏览器完成登录，凭据会自动写回。';
    const isSms = info.oauth === 'loomy';
    const isQr = info.oauth === 'raccoon';
    $('oauthStartBtn').querySelector('.btn-label').textContent = isSms
      ? '发送验证码'
      : isQr
        ? '生成登录二维码'
        : appendAccount
          ? '追加账号'
          : '一键授权';
    $('connectSms').hidden = !isSms;
  }

  if (info.strategy === 'keyless') {
    $('keylessHint').textContent = info.local
      ? '本机运行时：无需账号与 Key。先确认服务已启动，再点「直接添加」。'
      : `该渠道无需账号与 Key。${info.note || ''}`;
  }
}

function setConnectResult(text, kind, { offerStart = false } = {}) {
  const node = $('connectResult');
  if (!text) {
    node.hidden = true;
    clear(node);
    node.className = 'connect-result';
    return;
  }
  node.hidden = false;
  node.className = `connect-result${kind === 'error' ? ' is-error' : ''}`;
  node.replaceChildren(document.createTextNode(text));

  if (offerStart) {
    const button = el('button', 'btn primary connect-start', '立即启动网关');
    button.type = 'button';
    button.addEventListener('click', startProxy);
    node.appendChild(button);
  }
}

function markWizardStep(step) {
  for (const node of document.querySelectorAll('#connectWizardSteps .wizard-step')) {
    const number = Number(node.dataset.step) || 0;
    node.classList.toggle('is-active', number === step);
    node.classList.toggle('is-done', number < step);
  }
}

/**
 * Success state for the connection wizard.
 *
 * The important product message is not "credential saved" but "this account
 * is now serving traffic". Show the pool counts and the next actions.
 */
function showConnectSuccess({ channel, channelLabel, account, message }) {
  const node = $('connectResult');
  if (!node) return;
  const pool = poolStats();
  const label = channelLabel || channelById(channel)?.label || channel || '渠道';
  const who = account || '账号';

  node.hidden = false;
  node.className = 'connect-result is-success';
  clear(node);

  const icon = el('div', 'result-icon', '✓');
  const body = el('div', 'result-body');
  body.appendChild(el('strong', 'result-title', '已加入代理池'));
  body.appendChild(
    el(
      'p',
      'result-text',
      message || `${label} 授权完成，${who} 已保存凭据并加入调度池。`
    )
  );

  const pills = el('div', 'result-pills');
  pills.appendChild(el('span', 'result-pill', label));
  pills.appendChild(el('span', 'result-pill', who));
  pills.appendChild(
    el(
      'span',
      'result-pill is-accent',
      `${pool.accounts} 个账号 · ${pool.maxConcurrency} 并发`
    )
  );
  body.appendChild(pills);

  const actions = el('div', 'result-actions');
  const poolBtn = el('button', 'btn secondary mini', '查看代理池');
  poolBtn.type = 'button';
  poolBtn.addEventListener('click', () => {
    setView('accounts');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  actions.appendChild(poolBtn);

  const startBtn = el(
    'button',
    'btn primary mini connect-start',
    state.status?.running ? '立即更新并应用' : '立即启动网关'
  );
  startBtn.type = 'button';
  startBtn.addEventListener('click', startProxy);
  actions.appendChild(startBtn);

  const again = el('button', 'ghost mini', '继续连接');
  again.type = 'button';
  again.addEventListener('click', () => {
    setConnectResult('', null);
    markWizardStep(1);
  });
  actions.appendChild(again);
  body.appendChild(actions);

  node.append(icon, body);
  markWizardStep(3);
}

function setOauthState(text, kind, linkUrl) {
  const node = $('oauthState');
  if (!text) {
    node.hidden = true;
    clear(node);
    return;
  }
  node.hidden = false;
  node.className = `connect-oauth-state${kind === 'ok' ? ' is-ok' : kind === 'error' ? ' is-error' : ''}`;
  node.replaceChildren(document.createTextNode(text));
  if (linkUrl) {
    node.appendChild(document.createTextNode(' '));
    const link = el('a', '', '打开授权页');
    link.href = linkUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    node.appendChild(link);
  }
}

function stopOauthPolling() {
  if (state.oauthTimer) {
    clearInterval(state.oauthTimer);
    state.oauthTimer = null;
  }
  state.oauthPopup = null;
  // Invalidate in-flight polls: clearing the timer does not cancel a request
  // already awaiting a response, and a stale reply must not repaint the panel
  // after the user switched to another provider.
  state.oauthGeneration += 1;
}

function stopClipboardWatch() {
  if (state.clipboardTimer) {
    clearInterval(state.clipboardTimer);
    state.clipboardTimer = null;
  }
}

/**
 * Watch the OS clipboard for a key while the user is on the provider's page.
 *
 * The server reads the clipboard (a localhost page cannot always use the async
 * clipboard API) but only returns a shape-checked candidate.
 */
function startClipboardWatch() {
  stopClipboardWatch();
  if (!$('autoCaptureInput').checked) return;

  state.clipboardTimer = setInterval(async () => {
    try {
      const data = await api('/admin/connect/clipboard');
      if (!data.candidate) return;
      if (data.signature === state.clipboardSignature) return;

      state.clipboardSignature = data.signature;
      if ($('connectKeyInput').value.trim() === data.candidate) return;

      $('connectKeyInput').value = data.candidate;
      setConnectResult('已从剪贴板读到 Key，正在自动校验…', null);
      stopClipboardWatch();
      await verifyAndAddKey({ fromClipboard: true });
    } catch {
      /* clipboard unavailable: manual paste still works */
    }
  }, 1500);
}

async function readClipboardIntoField() {
  try {
    const data = await api('/admin/connect/clipboard');
    if (!data.available) {
      setConnectResult('读取不到剪贴板（可能是权限或平台限制），请手动粘贴。', 'error');
      return;
    }
    if (!data.candidate) {
      setConnectResult('剪贴板里没有识别到 API Key，请复制 Key 后重试。', 'error');
      return;
    }
    $('connectKeyInput').value = data.candidate;
    state.clipboardSignature = data.signature;
    setConnectResult('已读取剪贴板中的 Key，正在校验…', null);
    await verifyAndAddKey({ fromClipboard: true });
  } catch (err) {
    setConnectResult(`读取剪贴板失败：${err.message}`, 'error');
  }
}

async function startOauth() {
  const info = connectInfoFor(state.connectSelected);
  if (!info?.oauth) return;

  // SMS has no page to open: step 1 is "send the code".
  if (info.oauth === 'loomy') return sendSmsCode(info);

  // WorkBuddy-family providers use the channel's own browser login, not the
  // generic OAuth registry.
  if (info.oauth === 'workbuddy') return startWorkbuddyFamilyLogin(info);

  const isQr = info.oauth === 'raccoon';

  // Open the popup synchronously so the browser treats it as a user gesture.
  let popup = null;
  if (!isQr) {
    try {
      popup = window.open('about:blank', '_blank');
    } catch {
      popup = null;
    }
  }

  const button = $('oauthStartBtn');
  setBusy(button, true);
  setConnectResult('', null);
  $('connectDevice').hidden = true;
  $('connectQr').hidden = true;
  setOauthState('正在创建授权会话…', 'pending');
  markWizardStep(2);

  const generation = state.oauthGeneration;

  try {
    const data = await api('/admin/connect/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ provider: info.oauth, channelId: info.id, label: 'Buddy2API' })
    });

    if (generation !== state.oauthGeneration) {
      try {
        popup?.close();
      } catch {
        /* ignore */
      }
      return;
    }

    setBusy(button, false);

    if (data.mode === 'device-code' && data.userCode) {
      $('connectDevice').hidden = false;
      $('connectUserCode').textContent = data.userCode;
      setOauthState('已打开授权页。确认设备码一致后完成登录，本页会自动继续。', 'pending', data.authUrl);
      if (popup && data.authUrl) popup.location.href = data.authUrl;
    } else if (data.mode === 'qr' && data.qrPayload) {
      renderQr(data.qrSvg);
      setOauthState('二维码已生成，请用微信扫码登录。', 'pending');
    } else if (popup && data.authUrl) {
      popup.location.href = data.authUrl;
      setOauthState('等待浏览器完成授权… 完成后会自动写入凭据。', 'pending');
    } else if (data.authUrl) {
      setOauthState('浏览器拦截了新窗口，请手动打开授权页。', 'pending', data.authUrl);
    }

    state.oauthPopup = popup;
    state.oauthProvider = info.oauth;
    state.oauthState = data.state;
    pollOauth(info, data.state);
  } catch (err) {
    try {
      popup?.close();
    } catch {
      /* ignore */
    }
    setOauthState(`发起授权失败：${err.message}`, 'error');
    setBusy(button, false);
  }
}

/**
 * WorkBuddy-family browser login (WorkBuddy / CodeBuddy).
 *
 * These channels own their login handshake, so the wizard delegates to the
 * channel's `/admin/login/*` endpoints instead of the OAuth registry.
 */
async function startWorkbuddyFamilyLogin(info) {
  let popup = null;
  try {
    popup = window.open('about:blank', '_blank');
  } catch {
    popup = null;
  }

  const button = $('oauthStartBtn');
  setBusy(button, true);
  setConnectResult('', null);
  $('connectDevice').hidden = true;
  $('connectQr').hidden = true;
  setOauthState('正在创建登录会话…', 'pending');
  markWizardStep(2);

  try {
    // Ensure the channel exists so its login endpoint has something to target.
    let channel = activeChannels().find((entry) => entry.id === info.id);
    const append = Boolean(channel && accountsOf(channel).length);
    if (!channel) {
      await api('/admin/channels/create', {
        method: 'POST',
        body: JSON.stringify({
          id: info.id,
          type: info.id === 'workbuddy' ? 'workbuddy' : 'codebuddy',
          label: info.name,
          baseUrl: info.baseUrl,
          models: (info.suggestedModels || []).join('\n')
        })
      });
      await refreshStatus({ silent: true });
      channel = activeChannels().find((entry) => entry.id === info.id);
    }

    const data = await api('/admin/login/start', {
      method: 'POST',
      body: JSON.stringify({
        channel: info.id,
        accountId: 'primary',
        createNew: append
      })
    });

    setBusy(button, false);

    if (popup && data.authUrl) {
      popup.location.href = data.authUrl;
      setOauthState('等待浏览器完成授权… 完成后会自动写入凭据。', 'pending');
    } else if (data.authUrl) {
      setOauthState('浏览器拦截了新窗口，请手动打开授权页。', 'pending', data.authUrl);
    }

    state.oauthPopup = popup;
    pollWorkbuddyFamilyLogin(info, data.state);
  } catch (err) {
    try {
      popup?.close();
    } catch {
      /* ignore */
    }
    setOauthState(`发起授权失败：${err.message}`, 'error');
    setBusy(button, false);
  }
}

function pollWorkbuddyFamilyLogin(info, loginState) {
  stopOauthPolling();
  const generation = state.oauthGeneration;
  const isStale = () => generation !== state.oauthGeneration;
  let attempts = 0;

  state.oauthTimer = setInterval(async () => {
    if (isStale()) return;
    attempts += 1;
    if (attempts > 150) {
      stopOauthPolling();
      setOauthState('授权超时，请重试', 'error');
      setBusy($('oauthStartBtn'), false);
      return;
    }

    try {
      const data = await api(
        `/admin/login/status?state=${encodeURIComponent(loginState)}&channel=${encodeURIComponent(info.id)}`
      );
      if (isStale()) return;

      if (data.status === 'success') {
        stopOauthPolling();
        setBusy($('oauthStartBtn'), false);
        const who = data.user?.username || data.user?.email || '账号';
        setOauthState(`授权完成：${who}`, 'ok');
        try {
          state.oauthPopup?.close();
        } catch {
          /* ignore */
        }
        await refreshStatus({ silent: true });
        await loadModels();
        showConnectSuccess({
          channel: info.id,
          channelLabel: info.name,
          account: who,
          message: `${info.name} 授权完成，${who} 的凭据已保存并加入代理池。`
        });
        return;
      }

      if (data.status === 'error') {
        stopOauthPolling();
        setBusy($('oauthStartBtn'), false);
        setOauthState(data.error || '授权失败', 'error');
      }
    } catch (err) {
      if (isStale()) return;
      stopOauthPolling();
      setBusy($('oauthStartBtn'), false);
      setOauthState(err.message, 'error');
    }
  }, 2000);
}

async function sendSmsCode(info) {  const phone = $('connectPhoneInput').value.trim();
  if (!phone) {
    setMsg($('smsMsg'), '请填写手机号', 'error');
    return;
  }

  const button = $('oauthStartBtn');
  setBusy(button, true);
  setMsg($('smsMsg'), '正在发送…', 'warn');
  setConnectResult('', null);

  try {
    const data = await api('/admin/connect/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ provider: info.oauth, channelId: info.id, phone })
    });
    state.oauthProvider = info.oauth;
    state.oauthState = data.state;
    $('smsCodeField').hidden = false;
    setMsg($('smsMsg'), '验证码已发送', 'ok');
    $('connectSmsCode').focus();
    pollOauth(info, data.state);
  } catch (err) {
    setMsg($('smsMsg'), err.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function submitSmsCode() {
  const info = connectInfoFor(state.connectSelected);
  if (!info?.oauth || !state.oauthState) return;
  const code = $('connectSmsCode').value.trim();
  if (!code) {
    setMsg($('smsMsg'), '请填写验证码', 'error');
    return;
  }

  const button = $('submitSmsBtn');
  setBusy(button, true);
  setMsg($('smsMsg'), '正在验证…', 'warn');

  try {
    await api('/admin/connect/oauth/submit', {
      method: 'POST',
      body: JSON.stringify({ provider: info.oauth, state: state.oauthState, code })
    });
    setMsg($('smsMsg'), '验证成功', 'ok');
    $('connectSmsCode').value = '';
  } catch (err) {
    setMsg($('smsMsg'), err.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

/** Render the login QR locally; the payload never leaves this machine. */
function renderQr(svg) {
  const box = $('connectQrImage');
  $('connectQr').hidden = false;
  clear(box);
  if (svg) {
    // Server-rendered so the pending login code stays on this machine.
    box.innerHTML = svg;
    return;
  }
  box.appendChild(el('div', 'connect-qr-hint', '二维码渲染失败，请刷新重试'));
}

function pollOauth(info, oauthState) {
  stopOauthPolling();
  const generation = state.oauthGeneration;
  const isStale = () => generation !== state.oauthGeneration;
  let attempts = 0;

  state.oauthTimer = setInterval(async () => {
    if (isStale()) return;
    attempts += 1;
    if (attempts > 200) {
      stopOauthPolling();
      setOauthState('授权超时，请重试', 'error');
      setBusy($('oauthStartBtn'), false);
      return;
    }

    try {
      const data = await api(
        `/admin/connect/oauth/status?provider=${encodeURIComponent(info.oauth)}&state=${encodeURIComponent(oauthState)}`
      );
      if (isStale()) return;

      if (data.status === 'success') {
        stopOauthPolling();
        setBusy($('oauthStartBtn'), false);
        setOauthState(data.message || '授权完成', 'ok');
        try {
          state.oauthPopup?.close();
        } catch {
          /* ignore */
        }
        await refreshStatus({ silent: true });
        await loadModels();
        showConnectSuccess({
          channel: data.channel,
          channelLabel: data.channelLabel,
          account: data.account?.username || data.account?.label || '账号',
          message: data.message
        });
        return;
      }

      if (data.status === 'error') {
        stopOauthPolling();
        setBusy($('oauthStartBtn'), false);
        setOauthState(data.error || '授权失败', 'error');
        $('connectQr').hidden = true;
        $('connectDevice').hidden = true;
        return;
      }

      if (data.status === 'pending' && data.qrSvg) renderQr(data.qrSvg);
    } catch (err) {
      if (isStale()) return;
      stopOauthPolling();
      setBusy($('oauthStartBtn'), false);
      setOauthState(err.message, 'error');
    }
  }, 1500);
}

async function verifyAndAddKey({ fromClipboard = false } = {}) {
  const info = connectInfoFor(state.connectSelected);
  if (!info) return;

  const apiKey = $('connectKeyInput').value.trim();
  if (!apiKey) {
    setConnectResult('请先粘贴 API Key', 'error');
    return;
  }

  stopClipboardWatch();
  const button = $('verifyKeyBtn');
  setBusy(button, true);
  setConnectResult('正在用真实对话端点校验这个 Key…', null);
  markWizardStep(2);

  try {
    const verified = await api('/admin/connect/verify', {
      method: 'POST',
      body: JSON.stringify({ preset: info.id, apiKey, baseUrl: info.baseUrl })
    });

    await createChannelFromPreset(info, apiKey, verified.models);
    $('connectKeyInput').value = '';
    await refreshStatus({ silent: true });
    await loadModels();
    showConnectSuccess({
      channel: info.id,
      channelLabel: info.name,
      account: 'API Key',
      message: verified.message || `${info.name} 的 Key 已保存，渠道已加入代理池。`
    });
  } catch (err) {
    setConnectResult(
      fromClipboard ? `剪贴板里的内容没能通过校验：${err.message}` : `校验失败：${err.message}`,
      'error'
    );
  } finally {
    setBusy(button, false);
  }
}

async function addKeylessChannel() {
  const info = connectInfoFor(state.connectSelected);
  if (!info) return;

  const button = $('addKeylessBtn');
  setBusy(button, true);
  setConnectResult('正在添加渠道…', null);
  markWizardStep(2);

  try {
    let models = info.suggestedModels || [];
    if (info.local) {
      const detected = await api(`/admin/connect/local?preset=${encodeURIComponent(info.id)}`);
      if (!detected.running) throw new Error('本机没有检测到该服务，请先启动它');
      models = detected.models?.length ? detected.models : models;
    }

    await createChannelFromPreset(info, '', models);
    await refreshStatus({ silent: true });
    await loadModels();
    showConnectSuccess({
      channel: info.id,
      channelLabel: info.name,
      account: info.local ? '本机服务' : '免密渠道',
      message: `${info.name} 已添加${models.length ? `，${models.length} 个模型` : ''}，并加入代理池。`
    });
  } catch (err) {
    setConnectResult(err.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function createChannelFromPreset(info, apiKey, models) {
  const existing = activeChannels().find((channel) => channel.id === info.id);
  const list = (models || []).join('\n');

  if (existing) {
    await api('/admin/channels/update', {
      method: 'POST',
      body: JSON.stringify({
        id: info.id,
        label: info.name,
        options: { baseUrl: info.baseUrl, apiKey, preset: info.id, models: list.split('\n').filter(Boolean) }
      })
    });
    return;
  }

  await api('/admin/channels/create', {
    method: 'POST',
    body: JSON.stringify({
      id: info.id,
      type: 'openai-compatible',
      label: info.name,
      baseUrl: info.baseUrl,
      apiKey,
      preset: info.id,
      models: list
    })
  });
}

async function detectLocalService() {
  const info = connectInfoFor(state.connectSelected);
  if (!info) return;

  const button = $('detectLocalBtn');
  setBusy(button, true);
  try {
    const data = await api(`/admin/connect/local?preset=${encodeURIComponent(info.id)}`);
    if (data.running) {
      setConnectResult(
        `检测到本机服务，${data.models?.length || 0} 个模型：${(data.models || []).slice(0, 5).join(', ')}`,
        null
      );
    } else {
      setConnectResult('本机没有检测到该服务，请先启动它。', 'error');
    }
  } catch (err) {
    setConnectResult(err.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function loadConnectPresets() {
  const list = state.status?.connect || [];
  if (!list.length) return;

  // Only rebuild when the catalogue changed; a status poll must not reset the
  // selected provider or interrupt an in-flight authorization.
  const signature = list.map((entry) => `${entry.id}:${entry.strategy}`).join('|');
  if (signature === state.connectSignature) return;
  state.connectSignature = signature;
  state.connect = list;

  renderConnectPresets();
  if (!state.connectSelected) {
    const preferred =
      list.find((entry) => activeChannels().some((channel) => channel.id === entry.id)) ||
      list.find((entry) => entry.id === 'codebuddy') ||
      list.find((entry) => entry.id === 'openrouter') ||
      list.find((entry) => entry.strategy === 'oauth') ||
      list[0];
    selectConnect(preferred.id);
  } else {
    selectConnect(state.connectSelected);
  }
}

/* ========================================================================== */
/* accounts                                                                   */
/* ========================================================================== */

function updateTokenPreview() {
  const text = $('tokenInput').value;
  const chips = $('parsedChips');
  const tokens = findTokens(text);
  clear(chips);

  if (!tokens.length) {
    chips.hidden = true;
    $('saveBtn').disabled = !text.trim();
    return;
  }

  chips.hidden = false;
  for (const item of tokens) {
    const chip = el('span', 'chip');
    const label = item.kind === 'refresh' ? '刷新令牌' : '访问令牌';
    chip.textContent = item.exp
      ? `${label} · ${new Date(item.exp * 1000).toLocaleDateString('zh-CN')} 到期`
      : label;
    chips.appendChild(chip);
  }
  $('saveBtn').disabled = false;
}

async function saveCredentials() {
  const source = $('tokenInput').value.trim();
  const channel = loginChannelStatus();
  if (!channel) {
    toast('还没有支持账号登录的渠道', 'error');
    return;
  }
  if (!source) {
    toast(`请先粘贴 ${channel.label} Token`, 'error');
    return;
  }

  const payload = { source, channel: channel.id };
  const deviceToken = $('deviceInput').value.trim();
  const userId = $('userInput').value.trim();
  if (deviceToken) payload.deviceToken = deviceToken;
  if (userId) payload.userId = userId;

  const button = $('saveBtn');
  setBusy(button, true);
  setMsg($('credMsg'), `正在向 ${channel.label} 校验 Token…`, 'warn');

  try {
    const data = await api('/admin/credentials', { method: 'POST', body: JSON.stringify(payload) });
    setMsg($('credMsg'), data.warning || '凭据已验证并加入代理池', data.warning ? 'warn' : 'ok');
    toast(data.warning || '凭据已验证并加入代理池', data.warning ? 'warn' : 'success');

    $('tokenInput').value = '';
    $('deviceInput').value = '';
    $('userInput').value = '';
    updateTokenPreview();
    state.modelTouched = false;

    await refreshStatus({ silent: true });
    await loadModels();
  } catch (err) {
    setMsg($('credMsg'), err.message, 'error');
    toast(err.message, 'error');
  } finally {
    setBusy(button, false);
    button.disabled = !$('tokenInput').value.trim();
  }
}

function setLoginFeedback(message, kind = 'pending', linkUrl = null) {
  const node = $('loginFeedback');
  node.hidden = false;
  node.className = `login-feedback is-${kind}`;
  node.replaceChildren(document.createTextNode(message));
  if (linkUrl) {
    node.appendChild(document.createTextNode(' '));
    const link = el('a', '', '打开授权页');
    link.href = linkUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.color = 'inherit';
    link.style.textDecoration = 'underline';
    node.appendChild(link);
  }
}

function renderLoginAccount(user) {
  const node = $('loginAccount');
  if (!node) return;
  if (!user) {
    node.hidden = true;
    clear(node);
    return;
  }
  node.hidden = false;
  clear(node);

  const avatar = el('span', 'avatar', String(user.username || user.email || '?').slice(0, 1).toUpperCase());
  const who = el('div', 'who');
  who.appendChild(el('span', 'name', user.username || user.email || '已连接'));
  if (user.email && user.email !== user.username) who.appendChild(el('span', 'email', user.email));
  node.append(avatar, who);
}

function renderLoginChannelPicker() {
  const box = $('loginChannelPicker');
  if (!box) return;
  clear(box);

  const channels = loginChannels();
  if (!channels.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.appendChild(el('span', 'picker-label', '登录渠道'));
  for (const channel of channels) {
    const chip = el(
      'button',
      `login-channel-chip${channel.id === loginChannelStatus()?.id ? ' is-active' : ''}`,
      channel.label || channel.id
    );
    chip.type = 'button';
    chip.addEventListener('click', () => {
      state.loginChannelId = channel.id;
      renderStatus();
    });
    box.appendChild(chip);
  }
}

function poolGroupHeader(channel, accounts) {
  const head = el('header', 'pool-group-head');
  const title = el('div', 'pool-group-title');

  const dot = el('span', 'channel-dot');
  if (channel.enabled === false) dot.classList.add('is-off');
  else if (channel.configured) dot.classList.add('is-on');
  else dot.classList.add('is-warn');
  title.appendChild(dot);
  title.appendChild(providerMark(channel.id, channel.label, 'xs'));
  title.appendChild(el('strong', '', channel.label || channel.id));

  if (channel.id === defaultChannelStatus()?.id) {
    title.appendChild(el('span', 'channel-badge is-default', '默认'));
  }
  title.appendChild(el('span', 'channel-badge', channelTypeLabel(channel)));

  const max = accounts.reduce(
    (sum, account) => sum + (account.enabled === false ? 0 : Number(account.maxConcurrency) || 1),
    0
  );
  const sessions = accounts.reduce((sum, account) => sum + (Number(account.sessions) || 0), 0);
  title.appendChild(
    el('span', 'pool-group-meta', `${accounts.length} 账号 · ${max} 并发 · ${sessions} 会话`)
  );
  head.appendChild(title);

  const actions = el('div', 'pool-group-actions');
  if (channel.capabilities?.login) {
    const add = el('button', 'ghost mini', '添加账号');
    add.type = 'button';
    add.disabled = state.loginBusy;
    add.addEventListener('click', () =>
      startLogin({ channel: channel.id, createNew: true, accountId: 'primary' })
    );
    actions.appendChild(add);
  }
  if (channel.type === 'account' && channel.capabilities?.oauth) {
    const reauth = el('button', 'ghost mini', '重新授权');
    reauth.type = 'button';
    reauth.addEventListener('click', () => openConnectFor(channel));
    actions.appendChild(reauth);
  }
  if (channel.type === 'openai-compatible') {
    const key = el('button', 'ghost mini', '更新 Key');
    key.type = 'button';
    key.addEventListener('click', () => editChannelKey(channel));
    actions.appendChild(key);
  }
  const manage = el('button', 'ghost mini', '渠道详情');
  manage.type = 'button';
  manage.addEventListener('click', () => setView('channels'));
  actions.appendChild(manage);
  head.appendChild(actions);
  return head;
}

function poolAccountRow(account) {
  const channel = channelById(account.channel);
  const row = el(
    'div',
    `account-row${account.enabled === false ? ' is-disabled' : ''}${account.coolingDown ? ' is-cooling' : ''}${accountKind(account) === 'key' ? ' is-key' : ''}`
  );

  const initial = String(accountName(account) || '?').slice(0, 1).toUpperCase();
  row.appendChild(el('div', 'avatar', initial));

  const who = el('div', 'who');
  const nameLine = el('div', 'name-line');
  nameLine.appendChild(el('span', 'name', accountName(account)));
  if (account.isPrimary) {
    nameLine.appendChild(
      el('span', 'account-badge primary', accountKind(account) === 'key' ? '主凭据' : '主账号')
    );
  }
  if (accountKind(account) === 'key') nameLine.appendChild(el('span', 'account-badge key', 'API Key'));
  if (account.coolingDown) nameLine.appendChild(el('span', 'account-badge cooling', '冷却中'));
  if (account.enabled === false) nameLine.appendChild(el('span', 'account-badge off', '已停用'));
  who.appendChild(nameLine);

  const meta = [];
  if (account.channelLabel) meta.push(account.channelLabel);
  if (account.email && account.email !== accountName(account)) meta.push(account.email);
  if (account.channelType === 'openai-compatible' && account.maskedApiKey) {
    meta.push(account.maskedApiKey);
  }
  meta.push(`ID ${account.id}`);
  who.appendChild(el('span', 'meta', meta.join(' · ')));
  row.appendChild(who);

  const usage = el('div', 'account-usage');
  const load = Number(account.load) || 0;
  const max = Number(account.maxConcurrency) || 1;
  const pct = Math.max(0, Math.min(100, Math.round((load / Math.max(1, max)) * 100)));
  usage.appendChild(el('span', 'usage-label', '并发'));
  usage.appendChild(el('strong', 'usage-value', `${load}/${max}`));
  const meter = el('span', 'load-meter');
  const bar = el('i');
  bar.style.width = `${pct}%`;
  if (pct >= 100) bar.classList.add('is-full');
  meter.appendChild(bar);
  usage.appendChild(meter);
  if (account.sessions) usage.appendChild(el('span', 'usage-sessions', `${account.sessions} 会话`));
  row.appendChild(usage);

  const expiry =
    accountKind(account) === 'key'
      ? {
          text: account.maskedApiKey ? 'Key 已保存' : '免密 / 无 Key',
          cls: ''
        }
      : expiryInfo(account.expiresAt);
  const expiryNode = el('span', `account-expiry ${expiry.cls}`.trim(), expiry.text);
  if (account.expiresAt) {
    expiryNode.title = `到期时间：${new Date(account.expiresAt).toLocaleString('zh-CN')}`;
  }
  row.appendChild(expiryNode);

  const actions = el('div', 'account-actions');

  if (accountKind(account) === 'key') {
    const update = el('button', 'ghost mini', '更新 Key');
    update.type = 'button';
    update.addEventListener('click', () => editChannelKey(channel));
    actions.appendChild(update);

    const test = el('button', 'ghost mini', '测试');
    test.type = 'button';
    test.addEventListener('click', () => testChannel(account.channel));
    actions.appendChild(test);
  } else if (channel?.capabilities?.login) {
    const login = el('button', 'ghost mini', '重新登录');
    login.type = 'button';
    login.disabled = state.loginBusy;
    login.addEventListener('click', () =>
      startLogin({ channel: account.channel, accountId: account.id })
    );
    actions.appendChild(login);

    if (account.hasRefreshToken) {
      const refresh = el('button', 'ghost mini', '刷新');
      refresh.type = 'button';
      refresh.addEventListener('click', () => refreshAccount(account));
      actions.appendChild(refresh);
    }
  } else {
    const reauth = el('button', 'ghost mini', '重新授权');
    reauth.type = 'button';
    reauth.addEventListener('click', () => openConnectFor(channel));
    actions.appendChild(reauth);

    if (account.hasRefreshToken) {
      const refresh = el('button', 'ghost mini', '刷新');
      refresh.type = 'button';
      refresh.addEventListener('click', () => refreshAccount(account));
      actions.appendChild(refresh);
    }
  }

  const edit = el('button', 'ghost mini', '编辑');
  edit.type = 'button';
  edit.addEventListener('click', () => editAccount(account));
  actions.appendChild(edit);

  const toggle = el('button', 'ghost mini', account.enabled === false ? '启用' : '停用');
  toggle.type = 'button';
  toggle.disabled = state.loginBusy;
  toggle.addEventListener('click', () => toggleAccount(account, account.enabled === false));
  actions.appendChild(toggle);

  if (!account.isPrimary) {
    const remove = el('button', 'ghost mini danger', '删除');
    remove.type = 'button';
    remove.disabled = state.loginBusy;
    remove.addEventListener('click', () => removeAccount(account));
    actions.appendChild(remove);
  }

  row.appendChild(actions);
  return row;
}

function renderPool() {
  const list = $('accountList');
  if (!list) return;

  const all = poolEntries();
  const stats = poolStats();
  if ($('poolAccountCount')) $('poolAccountCount').textContent = String(stats.accounts);
  if ($('poolAccountMeta')) {
    $('poolAccountMeta').textContent = stats.accounts
      ? `${stats.active} 个启用${stats.cooling ? ` · ${stats.cooling} 个冷却` : ''}`
      : '暂无账号';
  }
  if ($('poolConcurrency')) $('poolConcurrency').textContent = String(stats.maxConcurrency);
  if ($('poolChannelCount')) $('poolChannelCount').textContent = String(stats.channels);
  if ($('poolSessions')) $('poolSessions').textContent = String(stats.sessions);

  const query = state.poolQuery.trim().toLowerCase();
  const rows = all.filter(
    (account) =>
      poolPassesFilter(account) &&
      (!query ||
        `${accountName(account)} ${account.email || ''} ${account.channelLabel || ''} ${
          account.id || ''
        }`
          .toLowerCase()
          .includes(query))
  );
  clear(list);

  if (!rows.length) {
    const hasFilter = Boolean(query) || state.poolFilter !== 'all';
    const empty = el('div', 'empty-state pool-empty');
    empty.appendChild(
      el('strong', '', all.length ? (hasFilter ? '没有匹配的账号' : '代理池还是空的') : '代理池还是空的')
    );
    empty.appendChild(
      el('span', '', all.length ? (hasFilter ? '换一个关键词或筛选条件。' : '连接一个渠道后，账号会自动出现在这里。') : '连接一个渠道后，账号会自动出现在这里。')
    );
    if (!all.length) {
      const connect = el('button', 'btn secondary mini', '去连接渠道');
      connect.type = 'button';
      connect.addEventListener('click', () => setView('connect'));
      empty.appendChild(connect);
    }
    list.appendChild(empty);
    return;
  }

  const groups = new Map();
  for (const account of rows) {
    const channel = channelById(account.channel) || {
      id: account.channel,
      label: account.channelLabel,
      type: account.channelType,
      enabled: account.channelEnabled,
      configured: account.channelConfigured,
      capabilities: account.capabilities,
      options: account.channelOptions
    };
    if (!groups.has(account.channel)) groups.set(account.channel, { channel, accounts: [] });
    groups.get(account.channel).accounts.push(account);
  }

  for (const { channel, accounts } of groups.values()) {
    const group = el('section', 'pool-group');
    group.appendChild(poolGroupHeader(channel, accounts));
    const body = el('div', 'pool-group-body');
    for (const account of accounts) body.appendChild(poolAccountRow(account));
    group.appendChild(body);
    list.appendChild(group);
  }
}

function renderOverviewPool() {
  const box = $('overviewPool');
  if (!box) return;
  clear(box);

  const rows = poolEntries();
  const stats = poolStats();
  if ($('poolMiniStats')) {
    $('poolMiniStats').textContent = rows.length
      ? `${stats.accounts} 个账号 · ${stats.maxConcurrency} 并发`
      : '0 个账号 · 0 并发';
  }
  if ($('poolMiniMeta')) {
    $('poolMiniMeta').textContent = rows.length
      ? `${stats.channels} 个渠道 · ${stats.sessions} 个会话粘滞`
      : '账号会自动加入调度池';
  }

  if (!rows.length) {
    const empty = el('div', 'empty-state');
    empty.appendChild(el('strong', '', '还没有账号'));
    empty.appendChild(el('span', '', '连接 WorkBuddy 或添加一个 API Key 渠道。'));
    box.appendChild(empty);
    return;
  }

  for (const account of rows.slice(0, 4)) {
    const row = el('div', 'pool-mini-row');
    row.appendChild(
      el('span', 'avatar sm', String(accountName(account)).slice(0, 1).toUpperCase())
    );
    const who = el('div', 'pool-mini-who');
    who.appendChild(el('strong', '', accountName(account)));
    who.appendChild(
      el(
        'span',
        '',
        `${account.channelLabel} · ${account.load ?? 0}/${account.maxConcurrency ?? 1} 并发${
          account.sessions ? ` · ${account.sessions} 会话` : ''
        }`
      )
    );
    row.appendChild(who);
    const dot = el('span', 'mini-status-dot');
    if (account.enabled === false || account.channelEnabled === false) dot.classList.add('is-off');
    else if (account.coolingDown) dot.classList.add('is-warn');
    else dot.classList.add('is-on');
    row.appendChild(dot);
    box.appendChild(row);
  }
}

async function toggleAccount(account, enabled) {
  if (state.loginBusy) return;
  try {
    await api('/admin/accounts/toggle', {
      method: 'POST',
      body: JSON.stringify({ id: account.id, enabled, channel: account.channel })
    });
    toast(enabled ? '账号已启用' : '账号已停用', 'success');
    await refreshStatus({ silent: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeAccount(account) {
  if (state.loginBusy) return;
  if (!window.confirm(`确定从 ${account.channelLabel} 删除账号 ${accountName(account)}？`)) return;
  try {
    await api('/admin/accounts/remove', {
      method: 'POST',
      body: JSON.stringify({ id: account.id, channel: account.channel })
    });
    toast('账号已删除', 'success');
    await refreshStatus({ silent: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function refreshAccount(account) {
  const channel = channelById(account.channel);
  if (!channel) return;
  try {
    if (channel.type === 'workbuddy' || channel.type === 'codebuddy') {
      await api('/admin/refresh', {
        method: 'POST',
        body: JSON.stringify({ channel: channel.id, accountId: account.id })
      });
    } else if (channel.type === 'account' && channel.options?.oauth) {
      await api('/admin/connect/oauth/refresh', {
        method: 'POST',
        body: JSON.stringify({
          provider: channel.options.oauth,
          channelId: channel.id,
          accountId: account.id
        })
      });
    } else {
      toast('该渠道没有可刷新的令牌', 'warn');
      return;
    }
    toast('令牌已刷新', 'success');
    await refreshStatus({ silent: true });
  } catch (err) {
    toast(`刷新失败：${err.message}`, 'error');
  }
}

function openEditor({ title, hint, fields, submitLabel = '保存', onSubmit }) {
  const dialog = $('editDialog');
  if (!dialog) return;

  $('editTitle').textContent = title;
  $('editHint').textContent = hint || '';
  const box = $('editFields');
  clear(box);
  const inputs = {};

  for (const field of fields || []) {
    const label = el('label', 'modal-field');
    label.appendChild(el('span', 'modal-label', field.label));
    let input;
    if (field.type === 'select') {
      input = document.createElement('select');
      for (const option of field.options || []) {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        input.appendChild(node);
      }
    } else {
      input = document.createElement('input');
      input.type = field.type || 'text';
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      if (field.step !== undefined) input.step = String(field.step);
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (field.placeholder) input.placeholder = field.placeholder;
    }
    input.value = field.value ?? '';
    label.appendChild(input);
    box.appendChild(label);
    inputs[field.name] = input;
  }

  $('editSubmit').textContent = submitLabel;
  state.editSubmit = async () => {
    const values = {};
    for (const [name, input] of Object.entries(inputs)) values[name] = input.value.trim();
    await onSubmit(values);
  };

  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  setTimeout(() => {
    const first = box.querySelector('input, select');
    first?.focus();
  }, 30);
}

function closeEditor() {
  const dialog = $('editDialog');
  state.editSubmit = null;
  if (!dialog) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

async function editAccount(account) {
  const channel = channelById(account.channel);
  openEditor({
    title: '编辑账号',
    hint: `${channel?.label || account.channelLabel} · ${accountName(account)}`,
    fields: [
      { name: 'label', label: '显示名称', value: account.label || '', placeholder: '便于识别的名称' },
      {
        name: 'maxConcurrency',
        label: '最大并发',
        type: 'number',
        min: 1,
        max: 20,
        value: account.maxConcurrency ?? 1
      }
    ],
    submitLabel: '保存账号设置',
    onSubmit: async (values) => {
      await api('/admin/accounts/update', {
        method: 'POST',
        body: JSON.stringify({
          channel: account.channel,
          id: account.id,
          label: values.label,
          maxConcurrency: Number(values.maxConcurrency)
        })
      });
      toast('账号设置已保存', 'success');
      await refreshStatus({ silent: true });
    }
  });
}

function editChannelKey(channel) {
  if (!channel) return;
  const hasKey = Boolean(channel.options?.hasKey);
  openEditor({
    title: hasKey ? '更新 API Key' : '填写 API Key',
    hint: `${channel.label} · ${channel.options?.baseUrl || 'OpenAI 兼容渠道'}`,
    fields: [
      {
        name: 'apiKey',
        label: 'API Key',
        type: 'password',
        value: '',
        placeholder: hasKey ? '已保存，输入新 Key 覆盖' : '粘贴服务商 Key'
      }
    ],
    submitLabel: '保存并测试',
    onSubmit: async (values) => {
      if (!values.apiKey) throw new Error('请输入新的 API Key');
      await api('/admin/channels/update', {
        method: 'POST',
        body: JSON.stringify({
          id: channel.id,
          options: { apiKey: values.apiKey }
        })
      });
      toast('API Key 已更新', 'success');
      await refreshStatus({ silent: true });
      await loadModels();
      try {
        const data = await api('/admin/channels/test', {
          method: 'POST',
          body: JSON.stringify({ id: channel.id })
        });
        toast(data.message || '渠道可用', 'success');
      } catch (err) {
        toast(`Key 已保存，但渠道测试失败：${err.message}`, 'warn');
      }
    }
  });
}

function openConnectFor(channel) {
  if (!channel) return;
  const candidates = [channel.options?.oauth, channel.options?.preset, channel.id].filter(Boolean);
  let preset = candidates.map((id) => connectInfoFor(id)).find(Boolean);
  if (!preset) {
    preset = state.connect.find((entry) => entry.name === channel.label);
  }
  setView('connect');
  if (preset) selectConnect(preset.id);
  setTimeout(() => {
    $('connectPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 80);
}

function addAccountFlow() {
  const channels = loginChannels();
  if (!channels.length) {
    toast('先连接一个支持账号登录的渠道（WorkBuddy / CodeBuddy）', 'warn');
    setView('connect');
    return;
  }
  const channel = loginChannelStatus();
  state.loginChannelId = channel.id;
  $('cardCredentials')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (state.loginBusy) return;
  if (channels.length > 1) {
    setLoginFeedback('有多个可登录渠道：先在下方选择渠道，再点登录或「添加账号」。', 'pending');
    return;
  }
  startLogin({ channel: channel.id, createNew: true, accountId: 'primary' });
}

function finishLoginError(message) {
  if (state.loginTimer) {
    clearInterval(state.loginTimer);
    state.loginTimer = null;
  }
  state.loginBusy = false;
  const button = $('loginBtn');
  setBusy(button, false);
  button.disabled = false;
  const channel = loginChannelStatus();
  button.querySelector('.btn-label').textContent = channel?.user
    ? '重新授权主账号'
    : `使用 ${channel?.label || '账号'} 登录`;
  $('addAccountBtn').disabled = false;
  renderPool();
  setLoginFeedback(message, 'error');
  toast(message, 'error');
}

function pollLogin(loginState, popup, target = {}, channel = loginChannelStatus()) {
  if (state.loginTimer) clearInterval(state.loginTimer);
  let attempts = 0;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (state.loginTimer) {
      clearInterval(state.loginTimer);
      state.loginTimer = null;
    }
  };

  state.loginTimer = setInterval(async () => {
    if (stopped) return;
    attempts += 1;
    if (attempts > 150) {
      stop();
      finishLoginError('授权超时，请重试');
      return;
    }

    try {
      const channelQuery = channel?.id ? `&channel=${encodeURIComponent(channel.id)}` : '';
      const data = await api(
        `/admin/login/status?state=${encodeURIComponent(loginState)}${channelQuery}`
      );
      if (data.status === 'success') {
        stop();
        state.loginBusy = false;
        if (channel?.id) state.loginChannelId = channel.id;
        const button = $('loginBtn');
        setBusy(button, false);
        button.disabled = false;
        $('addAccountBtn').disabled = false;
        const who = data.user?.username || data.user?.email || '账号';
        const action = target.createNew ? '账号已加入代理池' : '登录成功';
        setLoginFeedback(
          data.warning ? `${action}，但${data.warning}` : `${action}：${who}，token 已自动更新`,
          data.warning ? 'pending' : 'success'
        );
        toast(target.createNew ? '账号已加入代理池' : '账号登录成功', data.warning ? 'warn' : 'success');
        try {
          popup?.close();
        } catch {
          /* ignore */
        }
        await refreshStatus({ silent: true });
        await loadModels();
        return;
      }

      if (data.status === 'error') {
        stop();
        finishLoginError(data.error || '登录失败');
      }
    } catch (err) {
      stop();
      finishLoginError(err.message);
    }
  }, 2000);
}

async function startLogin(target = {}) {
  if (state.loginBusy) return;

  const channel = target.channel ? channelById(target.channel) : loginChannelStatus();
  if (!channel) {
    toast('还没有支持账号登录的渠道，请先连接 WorkBuddy 或 CodeBuddy', 'warn');
    setView('connect');
    return;
  }
  state.loginChannelId = channel.id;

  // Open the popup synchronously so the browser treats it as a user gesture.
  let popup = null;
  try {
    popup = window.open('about:blank', '_blank');
  } catch {
    popup = null;
  }

  state.loginBusy = true;
  const button = $('loginBtn');
  setBusy(button, true);
  button.querySelector('.btn-label').textContent = '正在打开授权页…';
  $('addAccountBtn').disabled = true;
  renderPool();
  setLoginFeedback(
    target.createNew
      ? `正在为 ${channel.label} 添加账号，请完成浏览器授权…`
      : `正在创建 ${channel.label} 登录会话…`,
    'pending'
  );

  try {
    const data = await api('/admin/login/start', {
      method: 'POST',
      body: JSON.stringify({ ...target, channel: channel.id })
    });
    if (popup) {
      popup.location.href = data.authUrl;
      setLoginFeedback('等待浏览器授权… 完成登录后会自动加入代理池', 'pending');
    } else {
      setLoginFeedback('浏览器拦截了新窗口，请点击「打开授权页」完成登录。', 'pending', data.authUrl);
    }
    pollLogin(data.state, popup, target, channel);
  } catch (err) {
    try {
      popup?.close();
    } catch {
      /* ignore */
    }
    if (/设备|device/i.test(err.message)) $('manualToken').open = true;
    finishLoginError(err.message);
  }
}

/* ========================================================================== */
/* gateway                                                                    */
/* ========================================================================== */

async function generateKey(showToast = true) {
  try {
    const data = await api('/admin/key', { method: 'POST' });
    $('keyInput').value = data.apiKey;
    state.lastServerKey = data.apiKey;
    if (showToast) toast('已生成新的 API Key', 'success');
    if (state.status?.running) await refreshStatus({ silent: true });
  } catch (err) {
    toast(`生成 Key 失败：${err.message}`, 'error');
  }
}

async function startProxy() {
  const button = $('startBtn');

  // The wizard's one-click button can fire before the picker has a value, so
  // fall back to the configured default (or the first listed model).
  if (!state.models.length && isConfigured()) await loadModels();
  let defaultModel = state.modelSelect?.getValue() || '';
  if (!defaultModel) defaultModel = state.status?.defaultModel || state.models[0]?.id || '';
  if (!defaultModel) {
    toast('请选择默认模型', 'error');
    return;
  }

  setBusy(button, true);
  setMsg($('startMsg'), '正在校验渠道并启动…', 'warn');

  try {
    const data = await api('/admin/start', {
      method: 'POST',
      body: JSON.stringify({
        apiKey: $('keyInput').value.trim(),
        defaultModel,
        contextWindow: Number(state.contextSelect?.getValue()) || undefined
      })
    });
    $('keyInput').value = data.apiKey;
    state.lastServerKey = data.apiKey;
    state.modelTouched = false;
    state.contextTouched = false;
    const note = data.fellBack
      ? `网关已启动，但原默认模型不可用，已切换到 ${data.defaultModel}`
      : `网关已启动，共 ${data.modelCount ?? '—'} 个可用模型`;
    setMsg($('startMsg'), note, data.fellBack ? 'warn' : 'ok');
    toast(data.fellBack ? note : '网关已启动', data.fellBack ? 'warn' : 'success');
    await refreshStatus({ silent: true });
    await loadLogs();
  } catch (err) {
    setMsg($('startMsg'), err.message, 'error');
    toast(err.message, 'error');
  } finally {
    setBusy(button, false);
    button.disabled = !isConfigured();
  }
}

async function stopProxy() {
  try {
    await api('/admin/stop', { method: 'POST' });
    toast('网关已停止', 'info');
    await refreshStatus({ silent: true });
  } catch (err) {
    toast(`停止失败：${err.message}`, 'error');
  }
}

/* ========================================================================== */
/* logs                                                                       */
/* ========================================================================== */

function logPassesFilter(row, filter) {
  if (filter === 'ok') return row.status < 400 && !row.error;
  if (filter === 'error') return row.status >= 400 || Boolean(row.error);
  return true;
}

function buildLogRow(row) {
  const node = el('div', 'log-row');

  node.appendChild(el('span', 'log-time', formatTime(row.at)));

  const model = el('span', 'log-model');
  model.appendChild(document.createTextNode(row.model || '—'));
  if (row.channel) {
    const small = el('small', '', ` ${row.channel}`);
    model.appendChild(small);
  }
  node.appendChild(model);

  const status = el(
    'span',
    `log-status${row.status >= 500 ? ' bad' : row.status >= 400 ? ' warn' : ''}`,
    String(row.status)
  );
  node.appendChild(status);

  node.appendChild(
    el(
      'span',
      'log-duration',
      row.durationMs >= 1000 ? `${(row.durationMs / 1000).toFixed(1)}s` : `${row.durationMs}ms`
    )
  );

  const tokens = row.promptTokens || row.completionTokens
    ? `${formatNumber(row.promptTokens ?? 0)}/${formatNumber(row.completionTokens ?? 0)}`
    : '—';
  node.appendChild(el('span', 'log-tokens', tokens));

  if (row.error) node.title = row.error;
  return node;
}

function renderLogs(logs, targetId, filter) {
  const list = $(targetId);
  if (!list) return;
  const query =
    targetId === 'logList' ? state.logQuery.trim().toLowerCase() : '';
  const rows = logs.filter(
    (row) =>
      logPassesFilter(row, filter || 'all') &&
      (!query ||
        `${row.model || ''} ${row.channel || ''} ${row.channelLabel || ''} ${row.error || ''}`
          .toLowerCase()
          .includes(query))
  );
  clear(list);

  if (!rows.length) {
    const empty = query
      ? '没有匹配的请求，换个关键词试试。'
      : logs.length
        ? '没有符合条件的记录'
        : state.status?.running
          ? '网关运行中，暂无请求。调用一次 API 后会显示在这里。'
          : '暂无请求，启动网关后在这里查看调用记录';
    list.appendChild(el('div', 'empty-state', empty));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const row of rows) fragment.appendChild(buildLogRow(row));
  list.appendChild(fragment);
}

async function loadLogs() {
  try {
    const data = await api('/admin/logs');
    const logs = Array.isArray(data.logs) ? data.logs : [];
    const signature = logs.length ? `${logs[0].at}-${logs.length}` : '0';
    if (signature === state.logsSignature) return;
    state.logsSignature = signature;
    state.logs = logs;

    renderLogs(logs, 'recentLogList', 'all');
    renderLogs(logs, 'logList', state.logFilter || 'all');
    $('recentMeta').textContent = logs.length
      ? `${logs.length} 条记录 · 最近 ${formatTime(logs[0].at)}`
      : '暂无请求';
    if ($('logMeta')) {
      $('logMeta').textContent = logs.length
        ? `${logs.length} 条记录 · 最近 ${formatTime(logs[0].at)}`
        : '暂无记录';
    }
  } catch {
    /* silent: status polling surfaces connection problems */
  }
}

/* ========================================================================== */
/* settings                                                                   */
/* ========================================================================== */

function renderSettings() {
  const s = state.status;
  if (!s) return;
  const routing = s.globalRouting || {};
  const config = s.config || {};

  if ($('namespaceSelect')) {
    $('namespaceSelect').value = ['always', 'never'].includes(routing.namespace) ? routing.namespace : 'auto';
  }
  if ($('routingDefaultInput') && document.activeElement !== $('routingDefaultInput')) {
    $('routingDefaultInput').value = routing.defaultModel || s.defaultModel || '';
  }
  if ($('exposeUnprefixedInput')) {
    $('exposeUnprefixedInput').checked = Boolean(routing.exposeUnprefixed);
  }
  if ($('infoConfig')) $('infoConfig').textContent = config.configPath || '—';
  if ($('infoHost')) $('infoHost').textContent = `${config.host || '—'}:${config.port ?? '—'}`;
  if ($('infoAuth')) $('infoAuth').textContent = config.authEnabled ? '已启用 API Key' : '未启用（仅本机）';
  if ($('infoChannels')) {
    const pools = poolStats();
    $('infoChannels').textContent = `${activeChannels().length} 个渠道 / ${pools.channels} 个入池`;
  }
  if ($('infoAccounts')) $('infoAccounts').textContent = `${poolStats().accounts} 个`;
  if ($('infoStatus')) $('infoStatus').textContent = s.running ? '运行中' : '已停止';

  const preview = $('routingPreview');
  if (preview) {
    clear(preview);
    const modeLabel = { auto: '自动', always: '总是加前缀', never: '从不加前缀' }[
      routing.namespace || 'auto'
    ];
    const rows = [
      ['默认模型', s.defaultModel || routing.defaultModel || '—'],
      ['命名空间', modeLabel],
      [
        '公开模型数',
        String(
          state.models.length ||
            activeChannels().reduce(
              (sum, channel) => sum + (Number(channel.modelCount) || 0),
              0
            )
        )
      ]
    ];
    for (const [label, value] of rows) {
      const row = el('div', 'routing-row');
      row.appendChild(el('span', 'routing-key', label));
      row.appendChild(el('strong', 'routing-value', value));
      preview.appendChild(row);
    }

    const aliases = Object.entries(routing.aliases || {});
    const aliasRow = el('div', 'routing-row');
    aliasRow.appendChild(el('span', 'routing-key', '别名'));
    if (aliases.length) {
      const chips = el('div', 'chip-row');
      for (const [from, to] of aliases) chips.appendChild(el('span', 'chip', `${from} → ${to}`));
      aliasRow.appendChild(chips);
    } else {
      aliasRow.appendChild(el('span', 'routing-value muted', '暂无别名'));
    }
    preview.appendChild(aliasRow);
  }
}

async function saveRouting() {
  const button = $('saveRoutingBtn');
  setBusy(button, true);
  setMsg($('routingMsg'), '正在保存…', 'warn');
  try {
    await api('/admin/routing/update', {
      method: 'POST',
      body: JSON.stringify({
        namespace: $('namespaceSelect').value,
        defaultModel: $('routingDefaultInput').value.trim(),
        exposeUnprefixed: $('exposeUnprefixedInput').checked
      })
    });
    setMsg($('routingMsg'), '已保存', 'ok');
    toast('路由设置已保存', 'success');
    await refreshStatus({ silent: true });
    await loadModels();
  } catch (err) {
    setMsg($('routingMsg'), err.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function reloadConfig() {
  const button = $('reloadConfigBtn');
  setBusy(button, true);
  setMsg($('reloadMsg'), '正在重新读取…', 'warn');
  try {
    await api('/admin/reload', { method: 'POST' });
    setMsg($('reloadMsg'), '已重新读取（监听端口变更需重启进程）', 'ok');
    await refreshStatus({ silent: true });
    await loadModels();
  } catch (err) {
    setMsg($('reloadMsg'), err.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

/* ========================================================================== */
/* custom select                                                              */
/* ========================================================================== */

class CustomSelect {
  constructor(root, { searchable = false, onChange } = {}) {
    this.root = root;
    this.searchable = searchable;
    this.onChange = onChange;
    this.options = [];
    this.value = '';
    this.open = false;
    this.disabled = false;

    root.classList.add('cselect');
    root.replaceChildren();

    this.trigger = el('button', 'cselect-trigger');
    this.trigger.type = 'button';
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');

    this.valueNode = el('span', 'cselect-value is-placeholder');
    this.trigger.appendChild(this.valueNode);
    this.trigger.appendChild(el('span', 'cselect-caret'));
    root.appendChild(this.trigger);

    this.trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggle();
    });

    document.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close();
    });
  }

  setOptions(options) {
    this.options = options || [];
    if (this.value && !this.hasValue(this.value)) this.value = '';
    this.renderValue();
    if (this.open) this.renderPanel();
  }

  setValue(value) {
    const next = String(value ?? '');
    if (next === this.value) return;
    this.value = next;
    this.renderValue();
  }

  getValue() {
    return this.value;
  }

  hasValue(value) {
    return this.options.some((option) => option.value === String(value));
  }

  hasOptions() {
    return this.options.length > 0;
  }

  setDisabled(disabled) {
    this.disabled = Boolean(disabled);
    this.trigger.disabled = this.disabled;
    if (this.disabled) this.close();
  }

  renderValue() {
    const option = this.options.find((item) => item.value === this.value);
    const placeholder = this.root.dataset.placeholder || '请选择';
    this.valueNode.textContent = option ? option.label : placeholder;
    this.valueNode.classList.toggle('is-placeholder', !option);
  }

  toggle() {
    if (this.disabled) return;
    if (this.open) this.close();
    else this.openPanel();
  }

  openPanel() {
    if (this.open || this.disabled) return;
    this.open = true;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.renderPanel();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.panel?.remove();
    this.panel = null;
  }

  renderPanel() {
    this.close();
    this.open = true;
    this.trigger.setAttribute('aria-expanded', 'true');

    const panel = el('div', 'cselect-panel');
    panel.addEventListener('click', (event) => event.stopPropagation());

    if (this.searchable) {
      const search = el('div', 'cselect-search');
      const input = document.createElement('input');
      input.type = 'search';
      input.placeholder = '搜索模型';
      input.addEventListener('input', () => renderOptions(input.value));
      search.appendChild(input);
      panel.appendChild(search);
      setTimeout(() => input.focus(), 0);
    }

    const optionsBox = el('div', 'cselect-options');
    panel.appendChild(optionsBox);

    const renderOptions = (query = '') => {
      clear(optionsBox);
      const q = query.trim().toLowerCase();
      const visible = this.options.filter((option) => {
        if (!q) return true;
        const haystack = `${option.label} ${option.description || ''} ${option.searchText || ''}`.toLowerCase();
        return haystack.includes(q);
      });

      if (!visible.length) {
        optionsBox.appendChild(el('div', 'cselect-empty', '没有匹配项'));
        return;
      }

      let lastGroup = '';
      for (const option of visible) {
        const group = option.group || '';
        if (group && group !== lastGroup) {
          optionsBox.appendChild(el('div', 'cselect-group-title', group));
          lastGroup = group;
        }
        const row = el('div', `cselect-option${option.value === this.value ? ' is-active' : ''}`);
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', option.value === this.value ? 'true' : 'false');
        row.appendChild(el('span', '', option.label));
        if (option.description) row.appendChild(el('span', 'opt-desc', option.description));
        row.addEventListener('click', () => {
          this.setValue(option.value);
          this.close();
          this.onChange?.(option.value);
        });
        optionsBox.appendChild(row);
      }
    };

    renderOptions();
    this.root.appendChild(panel);
    this.panel = panel;
  }
}

/* ========================================================================== */
/* wiring                                                                     */
/* ========================================================================== */

function bind() {
  // -- navigation
  for (const button of document.querySelectorAll('.nav-item')) {
    button.addEventListener('click', () => {
      setView(button.dataset.view);
      setMobileMenu(false);
    });
  }
  $('menuBtn').addEventListener('click', () => setMobileMenu(true));
  $('sidebarClose').addEventListener('click', () => setMobileMenu(false));
  $('sidebarBackdrop').addEventListener('click', () => setMobileMenu(false));
  $('mobileStatus').addEventListener('click', () => setView('overview'));

  // -- command palette
  $('commandBtn').addEventListener('click', openCommandPalette);
  $('mobileCommandBtn').addEventListener('click', openCommandPalette);
  $('commandInput').addEventListener('input', () => {
    state.commandIndex = 0;
    renderCommandResults($('commandInput').value);
  });
  $('commandInput').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveCommand(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveCommand(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      executeCommand(state.commandFiltered[state.commandIndex]);
    }
  });
  $('commandDialog').addEventListener('click', (event) => {
    if (event.target === $('commandDialog')) $('commandDialog').close();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openCommandPalette();
    }
    if (event.key === 'Escape') setMobileMenu(false);
  });
  for (const button of document.querySelectorAll('[data-goto]')) {
    button.addEventListener('click', () => setView(button.dataset.goto));
  }
  window.addEventListener('hashchange', () => {
    const name = location.hash.replace('#', '');
    if (name && name !== state.view) setView(name, { push: false });
  });

  // -- status
  $('refreshAllBtn').addEventListener('click', async () => {
    await refreshStatus();
    await loadModels();
    toast('已刷新', 'success');
  });
  $('statusPill').addEventListener('click', () => setView('overview'));

  // -- channels
  $('channelSearch').addEventListener('input', () => {
    state.channelQuery = $('channelSearch').value;
    renderChannels(activeChannels());
  });
  $('channelFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.channelFilter = button.dataset.filter;
    for (const chip of $('channelFilters').querySelectorAll('.chip')) {
      chip.classList.toggle('is-active', chip === button);
    }
    renderChannels(activeChannels());
  });
  $('createChannelBtn').addEventListener('click', createChannel);

  // -- connect
  $('connectSearch').addEventListener('input', () => {
    state.connectQuery = $('connectSearch').value;
    renderConnectPresets();
  });
  $('oauthStartBtn').addEventListener('click', startOauth);
  $('copyUserCodeBtn').addEventListener('click', async () => {
    const code = $('connectUserCode').textContent || '';
    if (!code || code === '—') return;
    const ok = await copyText(code);
    toast(ok ? '设备码已复制' : '复制失败', ok ? 'success' : 'error');
  });
  $('verifyKeyBtn').addEventListener('click', () => verifyAndAddKey());
  $('addKeylessBtn').addEventListener('click', addKeylessChannel);
  $('detectLocalBtn').addEventListener('click', detectLocalService);
  $('pasteKeyBtn').addEventListener('click', readClipboardIntoField);
  $('sendSmsBtn').addEventListener('click', () => {
    const info = connectInfoFor(state.connectSelected);
    if (info) sendSmsCode(info);
  });
  $('submitSmsBtn').addEventListener('click', submitSmsCode);
  $('connectSmsCode').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitSmsCode();
  });
  $('openKeyPageBtn').addEventListener('click', () => {
    const info = connectInfoFor(state.connectSelected);
    if (!info?.keyUrl) return;
    window.open(info.keyUrl, '_blank', 'noopener');
    state.clipboardSignature = '';
    startClipboardWatch();
    setConnectResult('已打开官方 Key 页面。登录并创建 Key 后点「复制」，这里会自动填入并校验。', null);
  });
  $('autoCaptureInput').addEventListener('change', () => {
    if (!$('autoCaptureInput').checked) stopClipboardWatch();
    else if (!$('connectStepKey').hidden) startClipboardWatch();
  });
  $('connectKeyInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') verifyAndAddKey();
  });

  // -- accounts
  $('tokenInput').addEventListener('input', updateTokenPreview);
  $('pasteBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return toast('剪贴板为空', 'warn');
      $('tokenInput').value = text;
      updateTokenPreview();
      toast('已粘贴', 'success');
    } catch {
      $('tokenInput').focus();
      toast('浏览器拒绝了剪贴板读取，请手动粘贴', 'warn');
    }
  });
  $('clearBtn').addEventListener('click', () => {
    $('tokenInput').value = '';
    $('deviceInput').value = '';
    $('userInput').value = '';
    updateTokenPreview();
    setMsg($('credMsg'), '', '');
  });
  $('saveBtn').addEventListener('click', saveCredentials);
  $('loginBtn').addEventListener('click', () => startLogin({ accountId: 'primary' }));
  $('addAccountBtn').addEventListener('click', addAccountFlow);

  const poolFilters = $('poolFilters');
  if (poolFilters) {
    poolFilters.addEventListener('click', (event) => {
      const button = event.target.closest('[data-pool-filter]');
      if (!button) return;
      state.poolFilter = button.dataset.poolFilter;
      for (const chip of poolFilters.querySelectorAll('.chip')) {
        chip.classList.toggle('is-active', chip === button);
      }
      renderPool();
    });
  }

  $('poolSearch').addEventListener('input', () => {
    state.poolQuery = $('poolSearch').value;
    renderPool();
  });

  const editDialog = $('editDialog');
  $('editCancel').addEventListener('click', closeEditor);
  if (editDialog) {
    editDialog.addEventListener('click', (event) => {
      if (event.target === editDialog) closeEditor();
    });
  }
  $('editSubmit').addEventListener('click', async () => {
    if (!state.editSubmit) return;
    const button = $('editSubmit');
    setBusy(button, true);
    try {
      await state.editSubmit();
      closeEditor();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(button, false);
    }
  });

  // -- model playground
  $('refreshTestModelsBtn').addEventListener('click', () => loadModels(true));
  $('runTestBtn').addEventListener('click', runModelTest);
  $('testInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      runModelTest();
    }
  });
  $('copyTestOutputBtn').addEventListener('click', async () => {
    if (!state.lastTestOutput) return;
    const ok = await copyText(state.lastTestOutput);
    toast(ok ? '输出已复制' : '复制失败', ok ? 'success' : 'error');
  });

  // -- gateway
  $('genKeyBtn').addEventListener('click', () => generateKey());
  $('regenBtn').addEventListener('click', () => generateKey());
  $('startBtn').addEventListener('click', startProxy);
  $('stopBtn').addEventListener('click', stopProxy);
  $('modelsBtn').addEventListener('click', () => loadModels(true));
  $('copySnippet').addEventListener('click', async () => {
    const ok = await copyText($('snippetText').textContent);
    toast(ok ? '示例已复制' : '复制失败', ok ? 'success' : 'error');
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const which = button.dataset.copy;
    const text = which === 'base' ? $('baseUrlText').textContent : $('apiKeyText').textContent;
    if (!text || text === '—') return;
    const ok = await copyText(text);
    toast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'success' : 'error');
  });

  // -- logs
  $('logFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.logFilter = button.dataset.filter;
    for (const chip of $('logFilters').querySelectorAll('.chip')) {
      chip.classList.toggle('is-active', chip === button);
    }
    renderLogs(state.logs, 'logList', state.logFilter);
  });

  $('logSearch').addEventListener('input', () => {
    state.logQuery = $('logSearch').value;
    renderLogs(state.logs, 'logList', state.logFilter || 'all');
  });

  // -- settings
  $('saveRoutingBtn').addEventListener('click', saveRouting);
  $('reloadConfigBtn').addEventListener('click', reloadConfig);
}

function initSelects() {
  state.modelSelect = new CustomSelect($('modelSelect'), {
    searchable: true,
    onChange: () => {
      state.modelTouched = true;
      state.contextTouched = false;
      updateModelDescription();
      updateContextOptions();
      renderModelChips();
    }
  });
  state.modelSelect.setDisabled(true);

  state.contextSelect = new CustomSelect($('contextSelect'), {
    onChange: () => {
      state.contextTouched = true;
      updateContextDescription();
    }
  });
  state.contextSelect.setDisabled(true);

  state.testModelSelect = new CustomSelect($('testModelSelect'), {
    searchable: true,
    onChange: () => updateTestModelHint()
  });
  state.testModelSelect.setDisabled(true);

  state.testChannelSelect = new CustomSelect($('testChannelSelect'), {
    onChange: (value) => {
      state.testChannel = value;
      renderTestModels();
    }
  });
  state.testChannelSelect.setDisabled(true);
}

async function init() {
  initSelects();
  bind();
  updateTokenPreview();

  const initial = location.hash.replace('#', '');
  setView(VIEWS.includes(initial) ? initial : 'overview', { push: false });

  await refreshStatus();

  if (isConfigured()) await loadModels();
  await loadLogs();

  setInterval(() => {
    if (!document.hidden) refreshStatus({ silent: true });
  }, 5000);
  setInterval(() => {
    if (!document.hidden && (state.view === 'logs' || state.view === 'overview')) loadLogs();
  }, 4000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshStatus({ silent: true });
      loadLogs();
    }
  });
}

init();
