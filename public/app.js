const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  models: [],
  lastServerKey: '',
  modelTouched: false,
  contextTouched: false,
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

  $('userLine').textContent = s.user?.username
    ? `${s.user.username}${s.user.email ? ` · ${s.user.email}` : ''}`
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
  const select = $('modelSelect');
  if (s.defaultModel && !state.modelTouched && select.value !== s.defaultModel) {
    select.value = s.defaultModel;
    updateModelDescription();
    state.contextTouched = false;
    updateContextOptions();
  }

  if (!state.contextTouched && state.models.length) {
    const contextSelect = $('contextSelect');
    const selected = state.models.find((item) => item.id === $('modelSelect').value);
    const contextKey = selected ? selected.root || selected.id : '';
    const settings = s.models?.contextWindow || {};
    const configuredContext = Number(settings.overrides?.[contextKey] ?? settings.default ?? 0);
    if (
      configuredContext &&
      contextSelect.value !== String(configuredContext) &&
      [...contextSelect.options].some((option) => option.value === String(configuredContext))
    ) {
      contextSelect.value = String(configuredContext);
      updateContextDescription();
    }
  }

  select.disabled = !configured || !state.models.length;
  $('contextSelect').disabled = !configured || !state.models.length || !$('contextSelect').options.length;
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
  const select = $('modelSelect');
  const previous = state.status?.defaultModel || select.value;
  select.replaceChildren();

  if (!state.models.length) {
    const option = document.createElement('option');
    option.textContent = '暂无模型';
    option.value = '';
    select.appendChild(option);
    select.disabled = true;
    return;
  }

  for (const model of state.models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id;
    select.appendChild(option);
  }

  if (previous && state.models.some((model) => model.id === previous)) {
    select.value = previous;
  } else {
    select.value = state.models[0].id;
  }

  if (state.status) {
    select.disabled = !(state.status.user || state.status.token?.expiresAt);
    $('modelsBtn').disabled = select.disabled;
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
  const select = $('modelSelect');
  for (const id of popular) {
    const model = state.models.find((item) => item.id === id);
    if (!model) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `model-chip${select.value === id ? ' is-active' : ''}`;
    button.textContent = id;
    button.title = model.name || id;
    button.addEventListener('click', () => {
      select.value = id;
      state.modelTouched = true;
      updateModelDescription();
      renderModelChips();
    });
    row.appendChild(button);
  }
}

function updateModelDescription() {
  const select = $('modelSelect');
  const model = state.models.find((item) => item.id === select.value);
  const desc = $('modelDesc');
  if (!model) {
    desc.textContent = '—';
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
  const select = $('contextSelect');
  const previous = Number(select.value) || 0;
  const model = state.models.find((item) => item.id === $('modelSelect').value);
  select.replaceChildren();

  if (!model) {
    const option = document.createElement('option');
    option.textContent = '暂无可用模型';
    option.value = '';
    select.appendChild(option);
    select.disabled = true;
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
    const option = document.createElement('option');
    option.textContent = '模型未声明';
    option.value = '';
    select.appendChild(option);
    select.disabled = true;
    updateContextDescription();
    return;
  }

  const configuredContextWindow = state.status?.models?.contextWindow || {};
  const contextKey = model.root || model.id;
  const configured = Number(
    configuredContextWindow.overrides?.[contextKey] ?? configuredContextWindow.default ?? 0
  );
  const desired =
    state.contextTouched && values.includes(previous)
      ? previous
      : values.includes(configured)
        ? configured
        : values[values.length - 1];

  for (const value of values) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = formatContext(value);
    select.appendChild(option);
  }

  select.value = String(desired);
  select.disabled = !(state.status?.user || state.status?.token?.expiresAt);
  updateContextDescription();
}

function updateContextDescription() {
  const desc = $('contextDesc');
  const model = state.models.find((item) => item.id === $('modelSelect').value);
  const selected = Number($('contextSelect').value) || 0;
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
  const defaultModel = $('modelSelect').value;
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
        contextWindow: Number($('contextSelect').value) || undefined
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
    row.title = entry.error || '';

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
  $('genKeyBtn').addEventListener('click', () => generateKey());
  $('regenBtn').addEventListener('click', () => generateKey());
  $('startBtn').addEventListener('click', startProxy);
  $('stopBtn').addEventListener('click', stopProxy);
  $('modelsBtn').addEventListener('click', () => loadModels(true));

  $('modelSelect').addEventListener('change', () => {
    state.modelTouched = true;
    state.contextTouched = false;
    updateModelDescription();
    updateContextOptions();
    renderModelChips();
  });

  $('contextSelect').addEventListener('change', () => {
    state.contextTouched = true;
    updateContextDescription();
  });

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

async function init() {
  bind();
  updateTokenPreview();
  await refreshStatus();

  if (state.status && (state.status.user || state.status.token?.expiresAt)) {
    await loadModels();
  }

  await loadLogs();
  setInterval(() => refreshStatus(), 5000);
  setInterval(() => loadLogs(), 4000);
}

init();
