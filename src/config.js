import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = process.env.WB2API_CONFIG
  ? path.resolve(process.env.WB2API_CONFIG)
  : path.join(ROOT, 'config.json');

export const DEFAULT_CONFIG = {
  server: {
    host: '127.0.0.1',
    port: 8787,
    // Empty array = no local authentication (only do this on a trusted machine).
    apiKeys: ['sk-wb2api-local'],
    // When empty, /admin/* only accepts requests from localhost.
    adminToken: '',
    // The proxy answers /v1 requests only after it is started from the dashboard.
    running: false,
    requestBodyLimitMb: 128
  },
  upstream: {
    baseUrl: 'https://www.workbuddy.ai',
    accessToken: '',
    refreshToken: '',
    deviceToken: '',
    userId: '',
    domain: 'www.workbuddy.ai',
    product: 'SaaS',
    client: {
      userAgent: 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0',
      ideType: 'WorkBuddy',
      ideName: 'WorkBuddy',
      ideVersion: '5.8.4',
      codebuddyRequest: '1'
    },
    // WorkBuddy appears to allow a very small number of concurrent free-model
    // requests per account. Queue locally instead of hammering it with 429s.
    maxConcurrency: 1,
    // Refresh the access token this many seconds before it expires.
    refreshSkewSeconds: 600,
    // How long we wait for response headers from upstream.
    headerTimeoutMs: 120000
  },
  models: {
    default: 'deepseek-v4.1-flash',
    // Context window advertised to clients through /v1/models. WorkBuddy's
    // own desktop session defaults to 300K, but the model API accepts up to
    // the model's maxInputTokens (DeepSeek: 1,000,000). The proxy never
    // truncates messages, so this value is what clients should budget for.
    contextWindow: {
      default: 1000000,
      overrides: {}
    },
    // Client model name -> real WorkBuddy model id.
    aliases: {
      'gpt-4o': 'deepseek-v4.1-flash',
      'gpt-4o-mini': 'deepseek-v4.1-flash',
      'gpt-4.1': 'deepseek-v4.1-flash',
      'claude-3-5-sonnet': 'deepseek-v4.1-flash',
      'claude-sonnet-4': 'deepseek-v4.1-flash'
    },
    // If a model keeps returning 429 (quota / model busy), try these instead.
    // Entries consume credits, so this is opt-in.
    fallback: {},
    // Pass through model ids we did not see in /v3/config.
    allowUnknown: true,
    cacheTtlSeconds: 600
  },
  prompt: {
    // WorkBuddy rejects requests whose first message is not a system prompt.
    system: 'You are a helpful assistant.',
    injectWhenMissing: true
  },
  retry: {
    maxAttempts: 3,
    baseDelayMs: 2500,
    maxDelayMs: 20000
  },
  logging: {
    requests: true
  }
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isObject(value) && isObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function applyEnvOverrides(cfg) {
  const env = process.env;
  if (env.WB2API_HOST) cfg.server.host = env.WB2API_HOST;
  if (env.PORT) cfg.server.port = Number(env.PORT);
  if (env.WB2API_API_KEYS !== undefined) {
    cfg.server.apiKeys = env.WB2API_API_KEYS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (env.WB2API_BASE_URL) cfg.upstream.baseUrl = env.WB2API_BASE_URL;
  if (env.WB2API_ACCESS_TOKEN) cfg.upstream.accessToken = env.WB2API_ACCESS_TOKEN;
  if (env.WB2API_REFRESH_TOKEN) cfg.upstream.refreshToken = env.WB2API_REFRESH_TOKEN;
  if (env.WB2API_DEVICE_TOKEN) cfg.upstream.deviceToken = env.WB2API_DEVICE_TOKEN;
  if (env.WB2API_USER_ID) cfg.upstream.userId = env.WB2API_USER_ID;
  if (env.WB2API_DEFAULT_MODEL) cfg.models.default = env.WB2API_DEFAULT_MODEL;
  if (env.WB2API_SYSTEM_PROMPT) cfg.prompt.system = env.WB2API_SYSTEM_PROMPT;
  return cfg;
}

export function loadConfig(file = CONFIG_PATH) {
  let fileConfig = {};
  if (fs.existsSync(file)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse ${file}: ${err.message}`);
    }
  }
  return applyEnvOverrides(deepMerge(DEFAULT_CONFIG, fileConfig));
}

export function saveConfig(cfg, file = CONFIG_PATH) {
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify(cfg, null, 2) + '\n';
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
