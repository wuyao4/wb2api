const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  models: [],
  lastServerKey: '',
  modelTouched: false,
  contextTouched: false,
  modelSelect: null,
  contextSelect: null,
  loginBusy: false,
  loginTimer: null,
  logsSignature: '',
  statusErrorShown: false
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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
    throw err;
  }
  return data;
}

function toast(message, type = 'info') {
  const stack = $('toastStack');
  const el = document.createElement('div');
  el.className = `toast ${type === 'info' ? '' : type}`.trim();
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 240);
  }, 3800);
}

function setBusy(button, busy) {
  button.classList.toggle('is-busy', busy);
  if (busy) button.disabled = true;
}

function setMsg(el, text, kind) {
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

function formatUptime(seconds) {  if (seconds == null) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
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
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function findTokens(text) {
  const matches = text.match(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g) || [];
  const seen = new Set();
  const out = [];
  for (const token of matches) {
    if (seen.has(token)) continue;
    seen.add(token);
    const payload = decodeJwt(token);
    if (!payload) continue;
    out.push({
      token,
      type: String(payload.typ || '').toLowerCase() === 'offline' ? 'refresh' : 'access',
      username: payload.preferred_username || payload.username || '',
      email: payload.email || '',
      exp: Number(payload.exp) || 0
    });
  }
  return out;
}

async function copyText(text) {
  if (!text) return false;
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
      document.execCommand('copy');
      area.remove();
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// custom select
// ---------------------------------------------------------------------------

class CustomSelect {
  constructor(element, { searchable = false, onChange = () => {} } = {}) {
    this.el = element;
    this.searchable = searchable;
    this.onChange = onChange;
    this.options = [];
    this.value = '';
    this.disabled = false;
    this.open = false;
    this.active = -1;
    this.filtered = [];
    this.query = '';
    this.build();
  }

  build() {
    this.el.classList.add('cselect');
    this.el.replaceChildren();

    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'cselect-trigger';
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.innerHTML = `
      <span class="cselect-value"><span class="t"></span><span class="s"></span></span>
      <svg class="cselect-chevron" viewBox="0 0 12 8" fill="none" aria-hidden="true">
        <path d="M1 1.5 6 6.5 11 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    this.el.appendChild(this.trigger);

    this.popover = document.createElement('div');
    this.popover.className = 'cselect-popover';
    this.popover.hidden = true;
    this.popover.tabIndex = -1;

    if (this.searchable) {
      this.search = document.createElement('input');
      this.search.className = 'cselect-search';
      this.search.placeholder = '搜索模型…';
      this.search.autocomplete = 'off';
      this.search.spellcheck = false;
      this.search.setAttribute('aria-label', '搜索模型');
      this.popover.appendChild(this.search);
    }

    this.list = document.createElement('div');
    this.list.className = 'cselect-list';
    this.list.setAttribute('role', 'listbox');
    this.list.tabIndex = -1;
    this.popover.appendChild(this.list);
    this.el.appendChild(this.popover);

    this.trigger.addEventListener('click', () => this.toggle());
    this.trigger.addEventListener('keydown', (event) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        this.openMenu();
      }
    });

    this.popover.addEventListener('focusout', (event) => {
      if (!this.el.contains(event.relatedTarget)) this.closeMenu(false);
    });

    if (this.search) {
      this.search.addEventListener('input', () => {
        this.query = this.search.value;
        this.active = 0;
        this.renderOptions();
      });
      this.search.addEventListener('keydown', (event) => this.handleKey(event));
    } else {
      this.popover.addEventListener('keydown', (event) => this.handleKey(event));
    }

    document.addEventListener('click', (event) => {
      if (!this.el.contains(event.target)) this.closeMenu(false);
    });

    this.renderLabel();
  }

  setOptions(options) {
    this.options = Array.isArray(options) ? options.slice() : [];
    if (!this.options.some((option) => option.value === this.value)) {
      this.value = this.options[0]?.value ?? '';
    }
    this.renderLabel();
    if (this.open) {
      this.query = '';
      if (this.search) this.search.value = '';
      this.active = -1;
      this.renderOptions();
    }
  }

  setValue(value) {
    const next = String(value ?? '');
    if (!this.options.some((option) => option.value === next)) return false;
    this.value = next;
    this.renderLabel();
    return true;
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
    this.disabled = !!disabled;
    this.trigger.disabled = this.disabled;
    if (this.disabled) this.closeMenu(false);
  }

  renderLabel() {
    const option = this.options.find((item) => item.value === this.value);
    const title = this.trigger.querySelector('.t');
    const subtitle = this.trigger.querySelector('.s');
    title.textContent = option ? option.label : this.el.dataset.placeholder || '请选择';
    subtitle.textContent = option?.description || '';
    this.trigger.title = option ? [option.label, option.description].filter(Boolean).join(' · ') : '';
  }

  toggle() {
    if (this.open) this.closeMenu();
    else this.openMenu();
  }

  openMenu() {
    if (this.disabled || this.open) return;
    this.open = true;
    this.popover.hidden = false;
    this.popover.classList.remove('is-up');
    this.trigger.setAttribute('aria-expanded', 'true');
    this.query = '';
    if (this.search) this.search.value = '';
    this.active = -1;
    this.renderOptions();

    const rect = this.trigger.getBoundingClientRect();
    const popoverHeight = this.popover.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < popoverHeight + 12 && rect.top > popoverHeight + 12) {
      this.popover.classList.add('is-up');
    }

    requestAnimationFrame(() => {
      if (this.search) this.search.focus();
      else this.popover.focus({ preventScroll: true });
      this.scrollActiveIntoView();
    });
  }

  closeMenu(refocus = true) {
    if (!this.open) return;
    this.open = false;
    this.popover.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    if (refocus) this.trigger.focus({ preventScroll: true });
  }

  renderOptions() {
    const query = this.query.trim().toLowerCase();
    this.filtered = this.options.filter((option) => {
      if (!query) return true;
      const text = `${option.label} ${option.description || ''} ${option.searchText || ''}`.toLowerCase();
      return text.includes(query);
    });

    this.list.replaceChildren();

    if (!this.filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'cselect-empty';
      empty.textContent = '没有匹配项';
      this.list.appendChild(empty);
      this.active = -1;
      return;
    }

    if (this.active < 0 || this.active >= this.filtered.length) {
      const selected = this.filtered.findIndex((option) => option.value === this.value);
      this.active = selected >= 0 ? selected : 0;
    }

    this.filtered.forEach((option, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cselect-option';
      button.tabIndex = -1;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', option.value === this.value ? 'true' : 'false');
      button.classList.toggle('is-selected', option.value === this.value);
      button.classList.toggle('is-active', index === this.active);

      const text = document.createElement('span');
      text.className = 'opt-text';
      const name = document.createElement('span');
      name.className = 'opt-name';
      name.textContent = option.label;
      text.appendChild(name);
      if (option.description) {
        const meta = document.createElement('span');
        meta.className = 'opt-meta';
        meta.textContent = option.description;
        text.appendChild(meta);
      }

      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = '✓';
      button.append(text, check);

      button.addEventListener('mouseenter', () => {
        this.active = index;
        this.updateActive();
      });
      button.addEventListener('click', () => this.selectOption(option));
      this.list.appendChild(button);
    });

    this.scrollActiveIntoView();
  }

  selectOption(option) {
    const changed = option.value !== this.value;
    this.value = option.value;
    this.renderLabel();
    this.closeMenu();
    if (changed) this.onChange(option.value);
  }

  handleKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeMenu();
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!this.open) {
        this.openMenu();
        return;
      }
      if (!this.filtered.length) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      this.active = (this.active + direction + this.filtered.length) % this.filtered.length;
      this.updateActive();
      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      if (!this.open || !this.filtered.length) return;
      event.preventDefault();
      this.active = event.key === 'Home' ? 0 : this.filtered.length - 1;
      this.updateActive();
      return;
    }

    if (event.key === 'Enter') {
      if (!this.open) return;
      event.preventDefault();
      const option = this.filtered[this.active];
      if (option) this.selectOption(option);
    }
  }

  updateActive() {
    this.list.querySelectorAll('.cselect-option').forEach((button, index) => {
      button.classList.toggle('is-active', index === this.active);
    });
    this.scrollActiveIntoView();
  }

  scrollActiveIntoView() {
    const node = this.list.querySelectorAll('.cselect-option')[this.active];
    if (node) node.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------------------
// token preview
// ---------------------------------------------------------------------------

function updateTokenPreview() {
  const text = $('tokenInput').value.trim();
  const chips = $('parsedChips');
  chips.replaceChildren();

  $('saveBtn').disabled = !text || $('saveBtn').classList.contains('is-busy');

  if (!text) {
    chips.hidden = true;
    return;
  }

  chips.hidden = false;
  const tokens = findTokens(text);

  if (!tokens.length) {
    const chip = document.createElement('span');
    chip.className = 'chip is-warn';
    const dot = document.createElement('span');
    dot.className = 'dot';
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode('未识别到 JWT，请检查粘贴内容'));
    chips.appendChild(chip);
    return;
  }

  for (const token of tokens) {
    const chip = document.createElement('span');
    chip.className = `chip${token.type === 'refresh' ? ' is-refresh' : ''}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    chip.appendChild(dot);

    const label = document.createElement('b');
    label.textContent = token.type === 'refresh' ? '刷新令牌' : '访问令牌';
    chip.appendChild(label);

    const who = token.username || token.email || '';
    if (who) chip.appendChild(document.createTextNode(` · ${who}`));

    if (token.exp) {
      const date = new Date(token.exp * 1000).toLocaleDateString('zh-CN');
      chip.appendChild(document.createTextNode(` · 至 ${date}`));
    }
    chips.appendChild(chip);
  }

  if (/x-device-token|deviceToken/i.test(text) || /x-user-id|userId/i.test(text)) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const dot = document.createElement('span');
    dot.className = 'dot';
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode('设备信息将一并保存'));
    chips.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// status rendering
// ---------------------------------------------------------------------------

function renderStatus() {
  const s = state.status;
  if (!s) return;

  const configured = !!(s.user || s.token?.expiresAt);
  const running = !!s.running;

  const pill = $('statusPill');
  pill.dataset.state = running ? 'running' : configured ? 'configured' : 'idle';
  $('statusText').textContent = running ? '运行中' : configured ? '已连接 · 未启动' : '未配置';

  const credState = $('credState');
  credState.textContent = configured ? '已连接' : '待填写';
  credState.classList.toggle('is-on', configured);

  const startState = $('startState');
  startState.textContent = running ? '运行中' : configured ? '已配置' : '等待凭据';
  startState.classList.toggle('is-on', running);

  const loginBtn = $('loginBtn');
  if (!state.loginBusy) {
    loginBtn.disabled = false;
    loginBtn.querySelector('.btn-label').textContent = s.user
      ? '重新登录 / 切换账号'
      : '使用 WorkBuddy 账号登录';
    if (s.user) {
      $('loginHint').textContent = `当前账号 ${s.user.username || s.user.email || ''} · 点击可重新授权或切换账号`;
    } else {
      $('loginHint').textContent = '在浏览器完成授权后自动写入 token，无需复制';
    }
  }
  renderLoginAccount(s.user);
  renderAccounts(s.accounts || []);
  $('addAccountBtn').disabled = state.loginBusy;
  $('accountFoot').textContent = `同一会话优先使用同一账号 · 当前保持 ${s.routing?.sessions ?? 0} 个会话`;

  const userName = s.user?.username;
  const userEmail = s.user?.email;
  $('userLine').textContent = userName
    ? userEmail && userEmail !== userName
      ? `${userName} · ${userEmail}`
      : userName
    : configured
      ? '已连接 WorkBuddy'
      : '未连接账号';

  const expiry = expiryInfo(s.token?.expiresAt);
  const expiryLine = $('expiryLine');
  expiryLine.textContent = expiry.text;
  expiryLine.className = `expiry ${expiry.cls}`.trim();
  expiryLine.title = s.token?.expiresAt
    ? `到期时间：${new Date(s.token.expiresAt).toLocaleString('zh-CN')}${s.token.hasRefreshToken ? '' : '（无刷新令牌）'}`
    : '';

  const stats = s.stats || {};
  $('statRequests').textContent = formatNumber(stats.requests ?? 0);
  $('statPrompt').textContent = formatNumber(stats.promptTokens ?? 0);
  $('statCompletion').textContent = formatNumber(stats.completionTokens ?? 0);
  $('statUptime').textContent = formatUptime(stats.uptimeSeconds ?? 0);

  // key input
  const serverKey = s.apiKey && s.apiKey !== 'sk-wb2api-local' ? s.apiKey : '';
  const keyInput = $('keyInput');
  if (serverKey && document.activeElement !== keyInput && (!keyInput.value || keyInput.value === state.lastServerKey)) {
    keyInput.value = serverKey;
  }
  if (!serverKey && !keyInput.value) keyInput.placeholder = '留空则自动生成';
  state.lastServerKey = serverKey;

  // model select
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
      const settings = s.models?.contextWindow || {};
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
  $('startBtn').querySelector('.btn-label').textContent = running ? '更新并应用' : '启动反代';

  $('cardOutput').classList.toggle('is-live', running);
  $('outputEmpty').hidden = running;
  $('outputLive').hidden = !running;

  if (running) {
    $('baseUrlText').textContent = s.baseUrl || '—';
    $('apiKeyText').textContent = s.apiKey || '—';
    $('readyMeta').textContent = `${s.defaultModel || '默认模型'} · OpenAI / Anthropic 兼容`;
    renderSnippet();
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

async function refreshStatus() {
  try {
    state.status = await api('/admin/status');
    state.statusErrorShown = false;
    renderStatus();
  } catch (err) {
    if (!state.statusErrorShown) {
      state.statusErrorShown = true;
      $('statusPill').dataset.state = 'error';
      $('statusText').textContent = '连接失败';
      toast(`无法读取状态：${err.message}`, 'error');
    }
  }
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

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
      description: model.name && model.name !== model.id ? model.id : '',
      searchText: `${model.id} ${model.name || ''} ${model.root || ''}`
    }))
  );

  const preferred = state.status?.defaultModel;
  if (!state.modelTouched && preferred && select.hasValue(preferred)) {
    select.setValue(preferred);
  }

  if (state.status) {
    const ready = !!(state.status.user || state.status.token?.expiresAt);
    select.setDisabled(!ready);
    $('modelsBtn').disabled = !ready;
  }

  renderModelChips();
  updateModelDescription();
  updateContextOptions();
}

function renderModelChips() {
  const row = $('modelChips');
  row.replaceChildren();
  const popular = [
    'deepseek-v4.1-flash',
    'deepseek-v4.1-flash-sg',
    'kimi-k3',
    'glm-5.3-flash',
    'gpt-5.6-luna'
  ];
  const select = state.modelSelect;
  const current = select?.getValue();
  for (const id of popular) {
    const model = state.models.find((item) => item.id === id);
    if (!model) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `model-chip${current === id ? ' is-active' : ''}`;
    button.textContent = id;
    button.title = model.name || id;
    button.addEventListener('click', () => {
      if (!select) return;
      select.setValue(id);
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
    desc.textContent = '保存凭据后加载模型列表';
    return;
  }
  const parts = [];
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

  select.setOptions(
    values.map((value) => ({
      value: String(value),
      label: formatContext(value)
    }))
  );

  const configuredContextWindow = state.status?.models?.contextWindow || {};
  const contextKey = model.root || model.id;
  const configured = Number(
    configuredContextWindow.overrides?.[contextKey] ?? configuredContextWindow.default ?? 0
  );
  const desired =
    state.contextTouched && select.hasValue(String(previous))
      ? String(previous)
      : select.hasValue(String(configured))
        ? String(configured)
        : String(values[values.length - 1]);

  select.setValue(desired);
  select.setDisabled(!(state.status?.user || state.status?.token?.expiresAt));
  updateContextDescription();
}

function updateContextDescription() {
  const desc = $('contextDesc');
  const model = state.models.find((item) => item.id === state.modelSelect?.getValue());
  const selected = Number(state.contextSelect?.getValue()) || 0;
  if (!model || !selected) {
    desc.textContent = '用于向客户端声明可用上下文，代理不会截断请求';
    return;
  }
  const max = Number(model.max_context_length || model.context_length || 0);
  desc.textContent = `声明 ${formatContext(selected)} · 模型上限 ${formatContext(max)} · 代理不会截断请求`;
}

async function loadModels(force = false) {
  const button = $('modelsBtn');
  setBusy(button, true);
  try {
    const data = await api('/admin/models');
    state.models = Array.isArray(data.data) ? data.data : [];
    renderModels();
    if (force) toast(`已加载 ${state.models.length} 个模型`, 'success');
  } catch (err) {
    toast(`模型列表加载失败：${err.message}`, 'error');
  } finally {
    setBusy(button, false);
    button.disabled = !(state.status?.user || state.status?.token?.expiresAt);
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function saveCredentials() {
  const source = $('tokenInput').value.trim();
  if (!source) {
    toast('请先粘贴 WorkBuddy Token', 'error');
    return;
  }

  const payload = { source };
  const deviceToken = $('deviceInput').value.trim();
  const userId = $('userInput').value.trim();
  if (deviceToken) payload.deviceToken = deviceToken;
  if (userId) payload.userId = userId;

  const button = $('saveBtn');
  setBusy(button, true);
  setMsg($('credMsg'), '正在向 WorkBuddy 校验 Token…', 'warn');

  try {
    const data = await api('/admin/credentials', { method: 'POST', body: JSON.stringify(payload) });
    setMsg($('credMsg'), data.warning || '凭据已验证并保存', data.warning ? 'warn' : 'ok');
    toast(data.warning || '凭据已验证并保存', data.warning ? 'warn' : 'success');

    $('tokenInput').value = '';
    $('deviceInput').value = '';
    $('userInput').value = '';
    updateTokenPreview();
    state.modelTouched = false;

    await refreshStatus();
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
  const el = $('loginFeedback');
  el.hidden = false;
  el.className = `login-feedback is-${kind}`;
  el.replaceChildren();
  el.appendChild(document.createTextNode(message));
  if (linkUrl) {
    el.appendChild(document.createTextNode(' '));
    const link = document.createElement('a');
    link.href = linkUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '打开授权页';
    link.style.color = 'inherit';
    link.style.textDecoration = 'underline';
    el.appendChild(link);
  }
}

function renderLoginAccount(user) {
  const el = $('loginAccount');
  if (!user) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  el.hidden = false;
  el.replaceChildren();

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = String(user.username || user.email || '?').slice(0, 1).toUpperCase();

  const who = document.createElement('div');
  who.className = 'who';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = user.username || user.email || '已连接';
  who.appendChild(name);
  if (user.email && user.email !== name.textContent) {
    const email = document.createElement('span');
    email.className = 'email';
    email.textContent = user.email;
    who.appendChild(email);
  }

  el.append(avatar, who);
}

function renderAccounts(accounts) {
  const list = $('accountList');
  list.replaceChildren();

  if (!accounts.length) {
    const empty = document.createElement('div');
    empty.className = 'account-empty';
    empty.textContent = '暂无账号';
    list.appendChild(empty);
    return;
  }

  for (const account of accounts) {
    const row = document.createElement('div');
    row.className = 'account-row';
    if (account.enabled === false) row.classList.add('is-disabled');
    if (account.coolingDown) row.classList.add('is-cooling');

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = String(account.username || account.email || account.label || '?')
      .slice(0, 1)
      .toUpperCase();

    const who = document.createElement('div');
    who.className = 'who';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = account.username || account.label || account.id;
    who.appendChild(name);

    const metaParts = [];
    if (account.email && account.email !== name.textContent) metaParts.push(account.email);
    metaParts.push(`并发 ${account.load ?? 0}/${account.maxConcurrency ?? 1}`);
    if (account.sessions) metaParts.push(`会话 ${account.sessions}`);
    if (account.expiresAt) {
      metaParts.push(`到期 ${new Date(account.expiresAt).toLocaleDateString('zh-CN')}`);
    }
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = metaParts.join(' · ');
    who.appendChild(meta);

    const badges = document.createElement('div');
    badges.className = 'account-badges';
    if (account.isPrimary) {
      const badge = document.createElement('span');
      badge.className = 'account-badge primary';
      badge.textContent = '主账号';
      badges.appendChild(badge);
    }
    if (account.coolingDown) {
      const badge = document.createElement('span');
      badge.className = 'account-badge cooling';
      badge.textContent = '冷却中';
      badges.appendChild(badge);
    }
    if (account.enabled === false) {
      const badge = document.createElement('span');
      badge.className = 'account-badge off';
      badge.textContent = '已停用';
      badges.appendChild(badge);
    }
    if (badges.childElementCount) who.appendChild(badges);

    const actions = document.createElement('div');
    actions.className = 'account-actions';

    const login = document.createElement('button');
    login.type = 'button';
    login.className = 'ghost mini';
    login.textContent = '登录';
    login.title = '重新走一次 WorkBuddy 授权';
    login.disabled = state.loginBusy;
    login.addEventListener('click', () => startLogin({ accountId: account.id }));
    actions.appendChild(login);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ghost mini';
    toggle.textContent = account.enabled === false ? '启用' : '停用';
    toggle.disabled = state.loginBusy;
    toggle.addEventListener('click', () => toggleAccount(account.id, account.enabled === false));
    actions.appendChild(toggle);

    if (!account.isPrimary) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ghost mini danger';
      remove.textContent = '删除';
      remove.disabled = state.loginBusy;
      remove.addEventListener('click', () => removeAccount(account.id));
      actions.appendChild(remove);
    }

    row.append(avatar, who, actions);
    list.appendChild(row);
  }
}

async function toggleAccount(id, enabled) {
  if (state.loginBusy) return;
  try {
    await api('/admin/accounts/toggle', {
      method: 'POST',
      body: JSON.stringify({ id, enabled })
    });
    toast(enabled ? '账号已启用' : '账号已停用', 'success');
    await refreshStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeAccount(id) {
  if (state.loginBusy) return;
  if (!window.confirm('确定删除这个账号？')) return;
  try {
    await api('/admin/accounts/remove', {
      method: 'POST',
      body: JSON.stringify({ id })
    });
    toast('账号已删除', 'success');
    await refreshStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
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
  button.querySelector('.btn-label').textContent = state.status?.user
    ? '重新登录 / 切换账号'
    : '使用 WorkBuddy 账号登录';
  $('addAccountBtn').disabled = false;
  renderAccounts(state.status?.accounts || []);
  setLoginFeedback(message, 'error');
  toast(message, 'error');
}

function pollLogin(loginState, popup, target = {}) {
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
      const data = await api(`/admin/login/status?state=${encodeURIComponent(loginState)}`);
      if (data.status === 'success') {
        stop();
        state.loginBusy = false;
        const button = $('loginBtn');
        setBusy(button, false);
        button.disabled = false;
        $('addAccountBtn').disabled = false;
        const who = data.user?.username || data.user?.email || '账号';
        const action = target.createNew ? '账号已添加' : '登录成功';
        setLoginFeedback(
          data.warning ? `${action}，但${data.warning}` : `${action}：${who}，token 已自动更新`,
          data.warning ? 'pending' : 'success'
        );
        toast(target.createNew ? '账号已添加' : '账号登录成功，token 已自动更新', data.warning ? 'warn' : 'success');
        try {
          popup?.close();
        } catch {
          /* ignore */
        }
        await refreshStatus();
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
  renderAccounts(state.status?.accounts || []);
  setLoginFeedback(
    target.createNew ? '正在添加账号，请完成浏览器授权…' : '正在创建登录会话…',
    'pending'
  );

  try {
    const data = await api('/admin/login/start', {
      method: 'POST',
      body: JSON.stringify(target)
    });
    if (popup) {
      popup.location.href = data.authUrl;
      setLoginFeedback('等待浏览器授权… 完成登录后会自动更新', 'pending');
    } else {
      setLoginFeedback('浏览器拦截了新窗口，请点击“打开授权页”完成登录。', 'pending', data.authUrl);
    }
    pollLogin(data.state, popup, target);
  } catch (err) {
    if (popup) {
      try {
        popup.close();
      } catch {
        /* ignore */
      }
    }
    if (/设备|device/i.test(err.message)) $('manualToken').open = true;
    finishLoginError(err.message);
  }
}

async function generateKey(showToast = true) {
  try {
    const data = await api('/admin/key', { method: 'POST' });
    $('keyInput').value = data.apiKey;
    state.lastServerKey = data.apiKey;
    if (showToast) toast('已生成新的 API Key', 'success');
    if (state.status?.running) await refreshStatus();
  } catch (err) {
    toast(`生成 Key 失败：${err.message}`, 'error');
  }
}

async function startProxy() {
  const button = $('startBtn');
  const defaultModel = state.modelSelect?.getValue();
  if (!defaultModel) {
    toast('请选择默认模型', 'error');
    return;
  }

  setBusy(button, true);
  setMsg($('startMsg'), '正在校验凭据并启动…', 'warn');

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
    setMsg($('startMsg'), `反代已启动，共 ${data.modelCount ?? '—'} 个可用模型`, 'ok');
    toast('反代已启动', 'success');
    await refreshStatus();
    await loadLogs();
    if (window.innerWidth < 960) {
      $('cardOutput').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (err) {
    setMsg($('startMsg'), err.message, 'error');
    toast(err.message, 'error');
  } finally {
    setBusy(button, false);
    button.disabled = !(state.status?.user || state.status?.token?.expiresAt);
  }
}

async function stopProxy() {
  try {
    await api('/admin/stop', { method: 'POST' });
    toast('反代已停止', 'info');
    await refreshStatus();
  } catch (err) {
    toast(`停止失败：${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

function renderLogs(logs) {
  const list = $('logList');
  if (!logs.length) {
    list.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = '暂无请求，启动后在这里查看调用记录';
    list.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of logs) {
    const row = document.createElement('div');
    row.className = 'log-row';
    const titleParts = [];
    if (entry.error) titleParts.push(entry.error);
    if (entry.account) titleParts.push(`账号 ${entry.account}`);
    if (entry.ttfbMs != null) titleParts.push(`首包 ${entry.ttfbMs}ms`);
    titleParts.push(`总耗时 ${entry.durationMs}ms`);
    row.title = titleParts.join(' · ');

    const time = document.createElement('span');
    time.className = 't';
    time.textContent = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
    row.appendChild(time);

    const kind = document.createElement('span');
    kind.className = `kind-badge${entry.kind === 'messages' ? ' anthropic' : ''}`;
    kind.textContent = entry.kind === 'messages' ? 'CLAUDE' : 'OPENAI';
    row.appendChild(kind);

    const model = document.createElement('span');
    model.className = 'm';
    model.textContent = entry.model + (entry.stream ? ' · stream' : '');
    row.appendChild(model);

    const status = document.createElement('span');
    status.className = `s${entry.status >= 500 ? ' bad' : entry.status >= 400 ? ' warn' : ''}`;
    status.textContent = String(entry.status);
    row.appendChild(status);

    const duration = document.createElement('span');
    duration.className = 'd';
    duration.textContent = entry.durationMs >= 1000 ? `${(entry.durationMs / 1000).toFixed(1)}s` : `${entry.durationMs}ms`;
    row.appendChild(duration);

    fragment.appendChild(row);
  }
  list.replaceChildren(fragment);
}

async function loadLogs() {
  try {
    const data = await api('/admin/logs');
    const logs = Array.isArray(data.logs) ? data.logs : [];
    const signature = logs.length ? `${logs[0].at}-${logs.length}` : '0';
    if (signature === state.logsSignature) return;
    state.logsSignature = signature;
    renderLogs(logs);
  } catch {
    /* silent: status polling will surface connection problems */
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

function bind() {
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
  $('addAccountBtn').addEventListener('click', () => startLogin({ createNew: true }));
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
}

async function init() {
  initSelects();
  bind();
  updateTokenPreview();
  await refreshStatus();

  if (state.status && (state.status.user || state.status.token?.expiresAt)) {
    await loadModels();
  }

  await loadLogs();
  setInterval(() => {
    if (!document.hidden) refreshStatus();
  }, 5000);
  setInterval(() => {
    if (!document.hidden) loadLogs();
  }, 4000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshStatus();
      loadLogs();
    }
  });
}

init();
