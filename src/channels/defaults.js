import { clone, deepMerge } from '../core/util.js';

/**
 * Declarative defaults for every channel *type*.
 *
 * A channel *instance* is `config.channels[<id>]`; its `type` selects one of
 * these blocks. Adding a new channel implementation means adding an entry here
 * (so config normalization knows the shape) and a matching definition in
 * `src/channels/registry.js`.
 */

const WORKBUDDY_CLIENT = {
  userAgent: 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0',
  ideType: 'WorkBuddy',
  ideName: 'WorkBuddy',
  ideVersion: '5.8.4',
  codebuddyRequest: '1'
};

export const DEFAULT_WORKBUDDY_MODELS = {
  default: 'deepseek-v4.1-flash',
  aliases: {
    'gpt-4o': 'deepseek-v4.1-flash',
    'gpt-4o-mini': 'deepseek-v4.1-flash',
    'gpt-4.1': 'deepseek-v4.1-flash',
    'claude-3-5-sonnet': 'deepseek-v4.1-flash',
    'claude-sonnet-4': 'deepseek-v4.1-flash'
  },
  // Entries consume credits, so fallback is opt-in per model.
  fallback: {},
  allowUnknown: true,
  cacheTtlSeconds: 600,
  contextWindow: {
    default: 1000000,
    overrides: {}
  }
};

export const DEFAULT_ROUTING = {
  // Keep the same account for a conversation when possible.
  sessionAffinity: true,
  affinityTtlMinutes: 60,
  maxSessions: 5000,
  // prefer: switch accounts if the sticky account is cooling down.
  // wait: keep the sticky account and let it wait out the cooldown.
  affinityOnCooldown: 'prefer',
  // Try another account once when the first one returns 429.
  failover: true,
  // Default per-account concurrency for added accounts.
  defaultAccountConcurrency: 2
};

export function primaryAccount(overrides = {}) {
  return {
    id: 'primary',
    label: '主账号',
    enabled: true,
    maxConcurrency: 1,
    accessToken: '',
    refreshToken: '',
    deviceToken: '',
    userId: '',
    ...overrides
  };
}

export function channelDefaults(type = 'openai-compatible') {
  if (type === 'workbuddy') {
    return {
      type: 'workbuddy',
      enabled: true,
      label: 'WorkBuddy',
      options: {
        baseUrl: 'https://www.workbuddy.ai',
        domain: 'www.workbuddy.ai',
        product: 'SaaS',
        platform: 'workbuddy-ai',
        client: { ...WORKBUDDY_CLIENT },
        // WorkBuddy allows very few concurrent free-model requests per account.
        refreshSkewSeconds: 600,
        headerTimeoutMs: 120000
      },
      models: clone(DEFAULT_WORKBUDDY_MODELS),
      routing: { ...DEFAULT_ROUTING },
      accounts: [primaryAccount()]
    };
  }

  // CodeBuddy (Tencent, China) speaks the same protocol as WorkBuddy with a
  // different endpoint, platform id and client identity. Verified live: the
  // auth-state endpoint returns a real state + authUrl.
  if (type === 'codebuddy') {
    return {
      type: 'codebuddy',
      enabled: true,
      label: 'CodeBuddy（腾讯）',
      options: {
        baseUrl: 'https://copilot.tencent.com',
        domain: 'copilot.tencent.com',
        product: 'SaaS',
        platform: 'codebuddy',
        client: {
          userAgent: 'CodeBuddyIDE/1.106.1',
          ideType: 'CodeBuddy',
          ideName: 'CodeBuddy',
          ideVersion: '1.106.1',
          codebuddyRequest: '1'
        },
        refreshSkewSeconds: 600,
        headerTimeoutMs: 120000
      },
      models: clone(DEFAULT_WORKBUDDY_MODELS),
      routing: { ...DEFAULT_ROUTING },
      accounts: [primaryAccount()]
    };
  }

  // Account-based OAuth channels: the credential is a bearer token with refresh
  // state, so `accounts[]` carries it instead of `options.apiKey`.
  if (type === 'account') {
    return {
      type: 'account',
      enabled: true,
      label: '账号渠道',
      oauth: '',
      options: {
        baseUrl: '',
        maxConcurrency: 4,
        headerTimeoutMs: 120000
      },
      models: {
        aliases: {},
        fallback: {},
        allowUnknown: true,
        cacheTtlSeconds: 600,
        contextWindow: { default: 0, overrides: {} }
      },
      routing: { ...DEFAULT_ROUTING, sessionAffinity: false },
      accounts: []
    };
  }

  return {
    type: 'openai-compatible',
    enabled: true,
    label: 'OpenAI 兼容',
    options: {
      baseUrl: '',
      apiKey: '',
      // Catalogue preset id (see src/channels/catalog.js), informational only.
      preset: '',
      apiKeyHeader: 'Authorization',
      apiKeyPrefix: 'Bearer ',
      headers: {},
      chatPath: '/chat/completions',
      modelsPath: '/models',
      // Ask OpenAI-compatible gateways for a usage block on the final chunk.
      includeUsage: true,
      headerTimeoutMs: 120000,
      // Static fallback used when /models is unavailable.
      models: []
    },
    models: {
      aliases: {},
      fallback: {},
      allowUnknown: true,
      cacheTtlSeconds: 600,
      contextWindow: {
        default: 0,
        overrides: {}
      }
    },
    routing: {
      ...DEFAULT_ROUTING,
      sessionAffinity: false
    },
    accounts: []
  };
}

function normalizeAccount(entry, type, index) {
  const account = { ...(entry || {}) };
  account.id = String(account.id || (index === 0 ? 'primary' : `account-${index + 1}`));
  account.label = String(account.label || (account.id === 'primary' ? '主账号' : account.id));
  account.enabled = account.enabled !== false;
  account.maxConcurrency = Math.max(1, Math.min(20, Number(account.maxConcurrency) || (type === 'workbuddy' || type === 'codebuddy' ? 1 : 4)));

  if (type === 'workbuddy' || type === 'codebuddy') {
    account.accessToken ||= '';
    account.refreshToken ||= '';
    account.deviceToken ||= '';
    account.userId ||= '';
  } else if (type === 'account') {
    // OAuth credential: token + refresh state, plus display identity.
    account.accessToken ||= '';
    account.refreshToken ||= '';
    account.expiresAt = Number(account.expiresAt) || 0;
    account.email ||= '';
    account.userId ||= '';
  } else {
    account.apiKey ||= '';
  }
  return account;
}

/**
 * Merge one persisted channel config with its type defaults, then repair the
 * structural bits the rest of the app relies on (ids, account shapes, caches).
 */
export function normalizeChannelConfig(id, raw = {}) {
  const type = String(raw?.type || (raw?.upstream ? 'workbuddy' : 'workbuddy'));
  const merged = deepMerge(channelDefaults(type), raw);
  merged.type = type;
  merged.id = id;
  merged.label = String(merged.label || id);
  merged.enabled = merged.enabled !== false;
  merged.options = merged.options || {};
  merged.models = merged.models || {};
  merged.models.contextWindow = {
    default: 0,
    overrides: {},
    ...(merged.models.contextWindow || {})
  };
  merged.models.contextWindow.overrides = merged.models.contextWindow.overrides || {};
  merged.models.aliases = merged.models.aliases || {};
  merged.models.fallback = merged.models.fallback || {};
  merged.routing = merged.routing || {};

  const accounts = Array.isArray(merged.accounts) ? merged.accounts : [];
  merged.accounts = accounts.map((entry, index) => normalizeAccount(entry, type, index));

  if ((type === 'workbuddy' || type === 'codebuddy') && !merged.accounts.length) {
    merged.accounts = [primaryAccount()];
  }

  // A generic channel always has at least one credential slot, even when the
  // upstream needs no key (Ollama, LM Studio, llama.cpp).
  if (type === 'openai-compatible' && !merged.accounts.length) {
    merged.accounts = [
      normalizeAccount(
        {
          id: 'primary',
          label: merged.label,
          apiKey: merged.options.apiKey || '',
          maxConcurrency: merged.options.maxConcurrency || 4
        },
        type,
        0
      )
    ];
  }

  // Account channels start with no credential: the OAuth flow fills it in.
  if (type === 'account' && !merged.accounts.length) {
    merged.accounts = [];
  }

  // Keep account ids unique so the pool and the admin API never collide.
  const seen = new Set();
  merged.accounts = merged.accounts.filter((account) => {
    if (seen.has(account.id)) return false;
    seen.add(account.id);
    return true;
  });

  return merged;
}

/**
 * Translate the pre-0.2 single-channel config (`upstream` + top-level
 * `accounts`/`models`/`routing`) into the multi-channel shape.
 */
export function channelsFromLegacy(file = {}) {
  const upstream = file.upstream || {};
  const models = file.models || clone(DEFAULT_WORKBUDDY_MODELS);
  const accounts = [
    primaryAccount({
      label: upstream.label || '主账号',
      enabled: upstream.enabled !== false,
      maxConcurrency: Number(upstream.maxConcurrency) || 1,
      accessToken: upstream.accessToken || '',
      refreshToken: upstream.refreshToken || '',
      deviceToken: upstream.deviceToken || '',
      userId: upstream.userId || ''
    }),
    ...(Array.isArray(file.accounts) ? file.accounts : [])
  ];

  const options = {};
  for (const key of ['baseUrl', 'domain', 'product', 'client', 'refreshSkewSeconds', 'headerTimeoutMs']) {
    if (upstream[key] !== undefined) options[key] = upstream[key];
  }

  const channel = normalizeChannelConfig('workbuddy', {
    type: 'workbuddy',
    enabled: true,
    label: 'WorkBuddy',
    options,
    models,
    routing: file.routing || {},
    accounts
  });

  return {
    channels: { workbuddy: channel },
    routing: {
      defaultModel: models.default ? `workbuddy/${models.default}` : 'workbuddy/deepseek-v4.1-flash'
    }
  };
}
