import { HttpError } from '../core/errors.js';
import { joinUrl } from '../core/util.js';
import { PROVIDER_PRESETS, presetById } from './catalog.js';

/**
 * Connection strategies for the provider presets.
 *
 * Three tiers, in order of automation:
 *
 *   'oauth'    — the provider publishes a programmatic authorization flow, so
 *                the dashboard can open it, catch the localhost callback and
 *                mint an API key without the user ever copying anything.
 *   'open-key' — no authorization API exists. The best we can do is deep-link
 *                to the official key page, then take the pasted key and verify
 *                it against the real chat endpoint.
 *   'keyless'  — no account at all (Kilo free pool, local runtimes).
 *
 * The `keyUrl` values are the official pages, verified reachable. They are
 * documentation/entry points, not scraped forms: we never automate a vendor's
 * login UI, because that breaks their terms and their CSRF defences.
 */

const CONNECT_META = {
  kilo: { strategy: 'keyless' },
  ollama: { strategy: 'keyless', local: true, detect: 'http://127.0.0.1:11434/v1/models' },
  lmstudio: { strategy: 'keyless', local: true, detect: 'http://127.0.0.1:1234/v1/models' },
  llamacpp: { strategy: 'keyless', local: true, detect: 'http://127.0.0.1:8080/v1/models' },

  openrouter: {
    strategy: 'oauth',
    oauth: 'openrouter',
    keyUrl: 'https://openrouter.ai/settings/keys',
    // OpenRouter publishes OAuth PKCE and explicitly supports localhost
    // callbacks on any port, which is what makes one-click possible here.
    note: '官方支持 OAuth PKCE：点「一键授权」会在本机起一个回调端口，登录后自动创建并写回 API Key。'
  },

  zcode: {
    strategy: 'oauth',
    oauth: 'zcode',
    baseUrl: 'https://zcode.z.ai/api/v1',
    note: '官方 CLI 设备授权流：打开智谱授权页登录后自动轮询取回 token，不需要端口回调。',
    suggestedModels: ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.2']
  },
  'minimax-code': {
    strategy: 'oauth',
    oauth: 'minimax-code',
    baseUrl: 'https://account.minimax.cn',
    note: '官方设备码 + PKCE：显示设备码后打开授权页确认，自动取回 token。',
    suggestedModels: ['MiniMax-M3', 'MiniMax-M2.7']
  },
  loomy: {
    strategy: 'oauth',
    oauth: 'loomy',
    baseUrl: 'https://loomyad.xunfei.cn/api/v1',
    note: '讯飞短信登录：填写手机号接收验证码即可，无需打开授权页。',
    suggestedModels: ['deepseek-v4-flash-0731', 'MiniMax-M3', 'Kimi-k2.6']
  },
  lobsterai: {
    strategy: 'oauth',
    oauth: 'lobsterai',
    baseUrl: 'https://lobsterai-server.youdao.com',
    note: '有道账号授权：打开官方门户登录后回调本机端口，自动写入 token。',
    suggestedModels: ['kimi-k3', 'deepseek-v4.1-flash', 'glm-5.3']
  },

  cline: {
    strategy: 'oauth',
    oauth: 'cline',
    baseUrl: 'https://api.cline.bot/api/v1',
    note: '官方 WorkOS 设备码：点「一键授权」会显示一个设备码，登录确认后自动写入 token，不需要端口回调。',
    suggestedModels: ['stealth/space-bunny-alpha', 'cline-free/mimo-v2.6-flash']
  },
  codebuddy: {
    strategy: 'oauth',
    oauth: 'workbuddy',
    baseUrl: 'https://copilot.tencent.com',
    note: '腾讯 CodeBuddy 国内版：与 WorkBuddy 同一套浏览器授权流程，登录后自动写入 token。',
    suggestedModels: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'kimi-k3']
  },
  qoder: {
    strategy: 'oauth',
    oauth: 'qoder',
    baseUrl: 'https://api2-v2.qoder.sh/model/v1',
    note: '官方 PKCE 设备码：打开授权页登录后自动轮询取回 token。',
    suggestedModels: ['qwen-flash', 'qwen3-coder']
  },
  'gemini-code-assist': {
    strategy: 'oauth',
    oauth: 'gemini-code-assist',
    baseUrl: 'https://cloudcode-pa.googleapis.com/v1internal',
    note: 'Google 官方 OAuth：登录 Google 账号并同意授权，回调到本机端口后自动写入 token。',
    suggestedModels: ['gemini-3.5-flash']
  },
  trae: {
    strategy: 'oauth',
    oauth: 'trae',
    baseUrl: 'https://trae-api-cn.mchost.guru/api/agent/v3',
    note: '官方 PKCE + 本机回调：登录后跳回 127.0.0.1 自动完成。',
    suggestedModels: ['DeepSeek-V4-Flash-Official', 'kimi-k3', 'glm-5.2']
  },
  raccoon: {
    strategy: 'oauth',
    oauth: 'raccoon',
    baseUrl: 'https://xiaohuanxiong.com/api/web/llm/v2',
    note: '微信扫码登录：二维码由本机生成，扫码后自动轮询取回 token，不需要回调端口。',
    suggestedModels: ['raccoon-auto', 'deepseek-v4.1-flash']
  },

  groq: { strategy: 'open-key', keyUrl: 'https://console.groq.com/keys' },
  deepseek: { strategy: 'open-key', keyUrl: 'https://platform.deepseek.com/api_keys' },
  gemini: { strategy: 'open-key', keyUrl: 'https://aistudio.google.com/apikey' },
  siliconflow: { strategy: 'open-key', keyUrl: 'https://cloud.siliconflow.com/account/ak' },
  nvidia: { strategy: 'open-key', keyUrl: 'https://build.nvidia.com/settings/api-keys' },
  cerebras: { strategy: 'open-key', keyUrl: 'https://cloud.cerebras.ai/platform/api-keys' },
  mistral: { strategy: 'open-key', keyUrl: 'https://console.mistral.ai/api-keys' },
  together: { strategy: 'open-key', keyUrl: 'https://api.together.ai/settings/projects/~current/api-keys' },
  fireworks: { strategy: 'open-key', keyUrl: 'https://app.fireworks.ai/settings/users/api-keys' },
  xai: { strategy: 'open-key', keyUrl: 'https://console.x.ai/team/default/api-keys' },
  moonshot: { strategy: 'open-key', keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  zai: { strategy: 'open-key', keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  minimax: { strategy: 'open-key', keyUrl: 'https://platform.minimax.io/console/access' },
  'opencode-zen': { strategy: 'open-key', keyUrl: 'https://opencode.ai/console' },
  vercel: { strategy: 'open-key', keyUrl: 'https://vercel.com/dashboard/ai-gateway/api-keys' }
};

/** Cheap model per provider, used for the 1-token key probe. */
const PROBE_MODEL = {
  kilo: 'kilo-auto/free',
  openrouter: 'deepseek/deepseek-v4.1-flash',
  groq: 'llama-3.1-8b-instant',
  deepseek: 'deepseek-chat',
  gemini: 'gemini-3.5-flash',
  siliconflow: 'Qwen/Qwen2.5-7B-Instruct',
  nvidia: 'deepseek-ai/deepseek-v4.1-flash',
  cerebras: 'llama3.1-8b',
  mistral: 'mistral-small-latest',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  fireworks: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
  xai: 'grok-4.7',
  moonshot: 'moonshot-v1-8k',
  zai: 'glm-5.3-flash',
  minimax: 'MiniMax-M2',
  'opencode-zen': 'big-pickle',
  vercel: 'deepseek/deepseek-v4.1-flash'
};

/** Names shown in the wizard for OAuth channels that are not key presets. */
const OAUTH_NAMES = {
  cline: 'Cline',
  qoder: 'Qoder',
  'gemini-code-assist': 'Gemini Code Assist',
  trae: 'TRAE',
  raccoon: 'Raccoon（商汤）',
  zcode: 'ZCode（智谱）',
  'minimax-code': 'MiniMax Code',
  loomy: 'Loomy（讯飞）',
  lobsterai: 'LobsterAI（有道）',
  codebuddy: 'CodeBuddy（腾讯）'
};

export function connectInfo(presetId) {
  const meta = CONNECT_META[presetId];
  if (!meta) return null;

  const preset = presetById(presetId);
  // OAuth channels are not API-key presets: their identity comes from the meta
  // entry (base URL + suggested models), not from the provider registry.
  if (!preset && meta.strategy !== 'oauth') return null;

  const source = preset || {
    id: presetId,
    name: OAUTH_NAMES[presetId] || meta.name || presetId,
    baseUrl: meta.baseUrl || '',
    apiKeyRequired: false,
    suggestedModels: meta.suggestedModels || [],
    note: ''
  };

  return {
    id: source.id,
    name: source.name,
    baseUrl: source.baseUrl,
    apiKeyRequired: source.apiKeyRequired,
    strategy: meta.strategy,
    oauth: meta.oauth || '',
    keyUrl: meta.keyUrl || source.apiKeyUrl || '',
    local: Boolean(meta.local || source.local),
    detectUrl: meta.detect || '',
    note: [source.note, meta.note].filter(Boolean).join(' '),
    suggestedModels: source.suggestedModels || []
  };
}

export function allConnectInfo() {
  const fromPresets = PROVIDER_PRESETS.map((preset) => connectInfo(preset.id)).filter(Boolean);
  const oauthOnly = Object.keys(CONNECT_META)
    .filter((id) => !presetById(id) && CONNECT_META[id].strategy === 'oauth')
    .map((id) => {
      const meta = CONNECT_META[id];
      return {
        id,
        name: OAUTH_NAMES[id] || meta.name || id,
        baseUrl: meta.baseUrl || '',
        apiKeyRequired: false,
        strategy: 'oauth',
        oauth: meta.oauth || id,
        keyUrl: meta.keyUrl || '',
        local: false,
        detectUrl: '',
        note: meta.note || '',
        suggestedModels: meta.suggestedModels || []
      };
    });

  // OAuth first: they are the only true one-click entries.
  return [...oauthOnly, ...fromPresets];
}

function authHeaders(preset, apiKey) {
  const header = preset.apiKeyHeader || 'Authorization';
  const prefix = preset.apiKeyPrefix === undefined ? 'Bearer ' : preset.apiKeyPrefix;
  return { [header]: `${prefix}${apiKey}`, 'Content-Type': 'application/json' };
}

function pickProbeModel(preset, models) {
  const explicit = PROBE_MODEL[preset.id];
  // Prefer the documented cheap model, but only if the provider still lists it;
  // a retired id would turn a healthy key into a bogus "model not found".
  if (explicit && models.includes(explicit)) return explicit;
  if (models.length) {
    const cheap = models.find((id) => /(:free$|-free$|nano|mini|flash|small|instant|haiku)/i.test(id));
    return cheap || models[0];
  }
  return explicit || preset.suggestedModels?.[0] || '';
}

/**
 * Verify an API key against the provider's real chat endpoint.
 *
 * A model listing is not proof: NVIDIA and Vercel serve their catalog to
 * anyone and still answer 401 on POST. One `max_tokens: 1` turn is the only
 * check that cannot be fooled.
 */
export async function verifyProviderKey({ presetId, apiKey, baseUrl, models = [], timeoutMs = 30000 }) {
  const preset = presetById(presetId) || { id: presetId, name: presetId, baseUrl };
  const key = String(apiKey || '').trim();
  const root = String(baseUrl || preset.baseUrl || '').trim();

  if (!root) throw new HttpError(400, '缺少 Base URL');
  if (preset.apiKeyRequired && !key) {
    throw new HttpError(
      400,
      `${preset.name} 需要 API Key${preset.apiKeyUrl ? `，获取地址：${preset.apiKeyUrl}` : ''}`
    );
  }

  const headers = key ? authHeaders(preset, key) : { 'Content-Type': 'application/json' };

  // 1. Model listing — best effort. Some gateways restrict /models for keys
  //    that still work for chat, so a listing failure is never fatal here.
  let available = Array.isArray(models) ? [...models] : [];
  let listingError = null;
  try {
    const res = await fetch(joinUrl(root, preset.modelsPath || '/models'), {
      headers,
      signal: AbortSignal.timeout(Math.min(timeoutMs, 20000))
    });
    if (res.ok) {
      const json = await res.json();
      const rows = Array.isArray(json) ? json : json?.data || json?.models || [];
      const ids = rows.map((row) => (typeof row === 'string' ? row : row?.id)).filter(Boolean);
      if (ids.length) available = ids;
    } else {
      listingError = `HTTP ${res.status}`;
      await res.text().catch(() => '');
    }
  } catch (error) {
    listingError = error.message;
  }

  const model = pickProbeModel(preset, available);
  if (!model) {
    throw new HttpError(
      400,
      `${preset.name} 没有可用于探测的模型${listingError ? `（模型列表失败：${listingError}）` : ''}，请手动填写模型清单`
    );
  }

  // 2. One-token chat probe.
  const res = await fetch(joinUrl(root, preset.chatPath || '/chat/completions'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false
    }),
    signal: AbortSignal.timeout(timeoutMs)
  }).catch((error) => {
    throw new HttpError(502, `探测请求失败：${error.message}`);
  });

  if (res.ok) {
    return { ok: true, model, models: available, message: `${preset.name} 可用（探测模型 ${model}）` };
  }

  const text = await res.text().catch(() => '');
  const detail = brief(text);

  if (res.status === 401 || res.status === 403) {
    throw new HttpError(
      401,
      `${preset.name} 拒绝了这个 Key（HTTP ${res.status}）${detail}`
    );
  }
  // A valid key with no quota still proves authentication worked.
  if (res.status === 402 || res.status === 429) {
    return {
      ok: true,
      warning: true,
      model,
      models: available,
      message: `${preset.name} Key 有效，但当前无额度或触发限流（HTTP ${res.status}）${detail}`
    };
  }
  if (res.status === 400 && /model|not found|unsupported/i.test(text)) {
    // If the listing itself was rejected, a model complaint proves nothing
    // about the key — treat it as an auth failure rather than a soft pass.
    if (/^40[13]$/.test(String(listingError || ''))) {
      throw new HttpError(401, `${preset.name} 拒绝了这个 Key（HTTP ${res.status}）${detail}`);
    }
    return {
      ok: true,
      warning: true,
      model,
      models: available,
      message: `${preset.name} Key 有效，但探测模型 ${model} 不被接受${detail}`
    };
  }

  throw new HttpError(502, `${preset.name} 探测失败（HTTP ${res.status}）${detail}`);
}

function brief(text) {
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  return `：${trimmed.slice(0, 180)}`;
}

/** Detect a locally running OpenAI-compatible runtime. */
export async function detectLocal(presetId) {
  const info = connectInfo(presetId);
  if (!info?.detectUrl) return { running: false };
  try {
    const res = await fetch(info.detectUrl, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { running: false, status: res.status };
    const json = await res.json();
    const rows = Array.isArray(json) ? json : json?.data || json?.models || [];
    return {
      running: true,
      models: rows.map((row) => (typeof row === 'string' ? row : row?.id)).filter(Boolean)
    };
  } catch {
    return { running: false };
  }
}
