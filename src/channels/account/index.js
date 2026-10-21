import { HttpError } from '../../core/errors.js';
import { maskToken } from '../../core/credentials.js';
import { AccountPool, sessionKeyFrom } from '../../core/pool.js';
import { warn } from '../../core/logger.js';
import { prepareCompatBody } from '../../protocol/openai.js';
import {
  CLINE_API_BASE,
  CLINE_CHAT_PATH,
  CLINE_FALLBACK_MODELS,
  CLINE_MODELS_PATH,
  CLINE_RECOMMENDED_PATH,
  clineRequestHeaders
} from '../oauth/cline.js';
import {
  GEMINI_CODE_ASSIST_BASE,
  GEMINI_LOAD_CODE_ASSIST_PATH,
  GEMINI_MODELS_PATH,
  GEMINI_STREAM_PATH
} from '../oauth/gemini.js';
import { QODER_OPENAPI_BASE, QODER_USERINFO_PATH } from '../oauth/qoder.js';
import {
  RACCOON_CHAT_PATH,
  RACCOON_MODELS_PATH,
  RACCOON_API_BASE,
  RACCOON_FALLBACK_MODELS
} from '../oauth/raccoon.js';
import { TRAE_AGENT_HOST, TRAE_CHAT_PATH, TRAE_FALLBACK_MODELS, TRAE_MODELS_PATH } from '../oauth/trae.js';
import { ZCODE_FALLBACK_MODELS, ZCODE_ORIGIN } from '../oauth/zcode.js';
import { MINIMAX_ACCOUNT_HOST, MINIMAX_FALLBACK_MODELS } from '../oauth/minimax.js';
import { LOOMY_API_BASE, LOOMY_FALLBACK_MODELS } from '../oauth/loomy.js';
import {
  LOBSTERAI_API_BASE,
  LOBSTERAI_CHAT_PATH,
  LOBSTERAI_FALLBACK_MODELS,
  LOBSTERAI_MODELS_PATH,
  lobsteraiHeaders
} from '../oauth/lobsterai.js';
import { OpenAICompatClient } from '../openai-compatible/client.js';

/**
 * Runtime for the account-based OAuth channels.
 *
 * These channels authenticate with a bearer token obtained from an OAuth flow,
 * so they reuse the generic OpenAI-compatible transport and differ only in:
 *   - which headers carry the token,
 *   - where the model list comes from,
 *   - which fallback catalogue to use when the list is unavailable.
 *
 * A channel that needs a non-OpenAI wire (Gemini's `streamGenerateContent`)
 * overrides `chat()`; everything else stays shared.
 */
export class AccountChannel {
  constructor({ id, config, appConfig, persist, spec }) {
    this.id = id;
    this.config = config;
    this.appConfig = appConfig;
    this.persist = persist;
    this.spec = spec;
    this.cachedModels = [];
    this.lastModelWarnAt = 0;
    this.pool = new AccountPool({
      entries: this.#accounts(),
      routing: config.routing,
      label: config.label || id,
      createClient: (entry) => this.#createClient(entry)
    });
  }

  get type() {
    return 'account';
  }

  get label() {
    return this.config.label || this.id;
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  get capabilities() {
    return {
      login: false,
      oauth: true,
      manualCredentials: false,
      multipleAccounts: true
    };
  }

  #accounts() {
    if (Array.isArray(this.config.accounts) && this.config.accounts.length) return this.config.accounts;
    // An account channel with no credential has no account slot: the OAuth flow
    // creates one. Do not invent a placeholder, or the dashboard would report a
    // phantom account that cannot answer a request.
    return [];
  }

  #createClient(entry) {
    return new OpenAICompatClient({
      options: {
        ...this.config.options,
        // An explicit baseUrl in the channel config wins over the spec default,
        // so a user (or a test) can point the channel at a mirror or a proxy.
        baseUrl: this.config.options?.baseUrl || this.spec.baseUrl || '',
        chatPath: this.spec.chatPath || '/chat/completions',
        modelsPath: this.spec.modelsPath || '/models',
        apiKey: entry.accessToken || '',
        apiKeyHeader: 'Authorization',
        apiKeyPrefix: 'Bearer ',
        headers: this.spec.headers ? this.spec.headers(entry) : {},
        fallbacks: this.config.models?.fallback || {}
      },
      account: entry,
      retry: this.appConfig.retry,
      channelLabel: this.label
    });
  }

  setConfig(config, appConfig = this.appConfig) {
    this.config = config;
    this.appConfig = appConfig;
    this.cachedModels = [];
    this.pool.setRouting(config.routing);
    this.pool.setEntries(this.#accounts());
  }

  setEnabled(enabled) {
    this.config.enabled = Boolean(enabled);
  }

  aliases() {
    return this.config.models?.aliases || {};
  }

  resolveModel(id) {
    const requested = String(id || '').trim() || this.config.models?.default || '';
    return this.aliases()[requested] || requested;
  }

  async listModels({ force = false } = {}) {
    const fallback = (this.spec.fallbackModels || []).map((row) => ({
      id: typeof row === 'string' ? row : row.id,
      name: typeof row === 'string' ? row : row.name || row.id
    }));

    const clients = this.pool.all().filter((account) => account.enabled).map((account) => account.client);
    let rows = null;

    for (const client of clients) {
      if (!client?.account?.accessToken) continue;
      try {
        rows = await client.fetchModels(force);
        if (rows?.length) break;
      } catch (error) {
        if (Date.now() - this.lastModelWarnAt > 300000) {
          this.lastModelWarnAt = Date.now();
          warn(`[${this.label}] model list failed: ${error.message}`);
        }
      }
    }

    if (!rows?.length) rows = this.cachedModels?.length ? this.cachedModels : fallback;
    this.cachedModels = rows;
    return rows.map((row) => normalizeModel(row, this.config, this.label));
  }

  hasModel(id) {
    if (!id) return false;
    if (this.aliases()[id]) return true;
    if (this.cachedModels?.some((row) => String(row.id) === id)) return true;
    return (this.spec.fallbackModels || []).some((row) => (row.id || row) === id);
  }

  modelInfo(id) {
    return this.cachedModels?.find((row) => String(row.id) === id) || null;
  }

  prepareRequest(body, model) {
    return prepareCompatBody(body, model, this.config.options);
  }

  async chat({ body, options = {}, sessionKey = '' }) {
    return this.pool.chat(body, options, sessionKey);
  }

  sessionKey(headers, body) {
    return sessionKeyFrom(headers, body);
  }

  status() {
    const accounts = this.pool.status((account) => {
      const entry = account.client?.account || {};
      return {
        channel: this.id,
        channelLabel: this.label,
        username: entry.email || entry.name || entry.label || '',
        email: entry.email || '',
        expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
        hasRefreshToken: Boolean(entry.refreshToken),
        hasCredentials: Boolean(entry.accessToken),
        maskedToken: maskToken(entry.accessToken || '')
      };
    });

    const primary = accounts[0] || null;
    return {
      id: this.id,
      type: this.type,
      label: this.label,
      enabled: this.enabled,
      capabilities: this.capabilities,
      configured: accounts.some((account) => account.hasCredentials),
      accountCount: accounts.length,
      modelCount: this.cachedModels?.length || 0,
      options: {
        baseUrl: this.config.options?.baseUrl || '',
        oauth: this.spec?.oauth || ''
      },
      accounts,
      user: primary?.username ? { username: primary.username, email: primary.email } : null,
      token: {
        expiresAt: primary?.expiresAt || null,
        expired: primary?.expiresAt ? new Date(primary.expiresAt).getTime() < Date.now() : null,
        hasRefreshToken: Boolean(primary?.hasRefreshToken),
        maskedAccessToken: primary?.maskedToken || ''
      },
      models: {
        default: this.config.models?.default || '',
        contextWindow: this.config.models?.contextWindow || {},
        aliases: this.aliases()
      },
      routing: {
        sessionAffinity: this.config.routing?.sessionAffinity === true,
        failover: this.config.routing?.failover !== false,
        sessions: this.pool.sessionCount()
      }
    };
  }

  describe() {
    const accounts = this.#accounts();
    const hasToken = accounts.some((entry) => entry.accessToken);
    return {
      id: this.id,
      type: this.type,
      label: this.label,
      enabled: this.enabled,
      capabilities: this.capabilities,
      options: {
        baseUrl: this.config.options?.baseUrl || this.spec.baseUrl || '',
        oauth: this.spec.oauth || '',
        hasToken
      },
      accountCount: accounts.length,
      configured: hasToken || Boolean(this.config.options?.baseUrl),
      models: {
        default: this.config.models?.default || '',
        aliases: this.aliases()
      }
    };
  }

  async validate() {
    const withToken = this.#accounts().filter((entry) => entry.accessToken);
    if (!withToken.length) {
      return { ok: false, error: `${this.label} 尚未授权，请先在连接向导完成登录` };
    }
    return { ok: true };
  }

  updateAccount({ id, label, maxConcurrency, enabled } = {}) {
    const entry = (this.config.accounts || []).find((account) => account.id === id);
    if (!entry) throw new HttpError(404, '账号不存在');

    if (typeof label === 'string' && label.trim()) entry.label = label.trim().slice(0, 60);
    if (maxConcurrency !== undefined) {
      const value = Number(maxConcurrency);
      if (!Number.isInteger(value) || value < 1 || value > 20) {
        throw new HttpError(400, 'maxConcurrency 必须是 1-20 的整数');
      }
      entry.maxConcurrency = value;
    }
    if (enabled !== undefined) entry.enabled = Boolean(enabled);

    this.persist();
    this.pool.setEntries(this.#accounts());
    return this.status();
  }

  toggleAccount({ id, enabled } = {}) {
    return this.updateAccount({ id, enabled });
  }

  removeAccount(id) {
    if (!id || id === 'primary') throw new HttpError(400, '该账号不能删除');
    const index = (this.config.accounts || []).findIndex((account) => account.id === id);
    if (index === -1) throw new HttpError(404, '账号不存在');
    this.config.accounts.splice(index, 1);
    this.persist();
    this.pool.setEntries(this.#accounts());
    return this.status();
  }
}

function normalizeModel(row, channelConfig, label) {
  const id = String(typeof row === 'string' ? row : row.id);
  const contextLength =
    Number(row.context_length ?? row.contextWindow ?? row.context_window ?? 0) ||
    Number(channelConfig.models?.contextWindow?.default) ||
    null;

  return {
    id,
    object: 'model',
    created: Number(row.created) || Math.floor(Date.now() / 1000),
    owned_by: row.owned_by || label,
    name: row.name || row.display_name || id,
    context_length: contextLength,
    context_window: contextLength,
    max_context_length: contextLength,
    max_input_tokens: contextLength,
    supported_context_lengths: contextLength ? [contextLength] : [],
    max_output_tokens: row.maxTokens ?? row.max_output_tokens ?? null,
    capabilities: {
      vision: Boolean(row.supportsImage ?? row.capabilities?.vision),
      tools: true,
      reasoning: Boolean(row.supportsThinking ?? row.capabilities?.reasoning)
    }
  };
}

/* ------------------------------------------------------------------ specs */

export const ACCOUNT_CHANNEL_SPECS = {
  cline: {
    oauth: 'cline',
    baseUrl: `${CLINE_API_BASE}/api/v1`,
    chatPath: CLINE_CHAT_PATH.replace('/api/v1', ''),
    modelsPath: CLINE_MODELS_PATH.replace('/api/v1', ''),
    fallbackModels: CLINE_FALLBACK_MODELS,
    headers: (entry) => clineRequestHeaders(entry.accessToken)
  },
  qoder: {
    oauth: 'qoder',
    // The public OpenAI-compatible inference host; it accepts generic model
    // names (the encrypted endpoint is not used by this gateway).
    baseUrl: 'https://api2-v2.qoder.sh/model/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    fallbackModels: ['qwen-flash', 'qwen3-coder']
  },
  'gemini-code-assist': {
    oauth: 'gemini-code-assist',
    baseUrl: `${GEMINI_CODE_ASSIST_BASE}/v1internal`,
    chatPath: ':streamGenerateContent',
    modelsPath: ':fetchAvailableModels',
    fallbackModels: ['gemini-3.5-flash']
  },
  trae: {
    oauth: 'trae',
    baseUrl: TRAE_AGENT_HOST,
    chatPath: TRAE_CHAT_PATH,
    modelsPath: TRAE_MODELS_PATH,
    fallbackModels: TRAE_FALLBACK_MODELS
  },
  raccoon: {
    oauth: 'raccoon',
    baseUrl: RACCOON_API_BASE,
    chatPath: RACCOON_CHAT_PATH,
    modelsPath: RACCOON_MODELS_PATH,
    fallbackModels: RACCOON_FALLBACK_MODELS
  },
  zcode: {
    oauth: 'zcode',
    baseUrl: `${ZCODE_ORIGIN}/api/v1`,
    chatPath: '/chat/completions',
    modelsPath: '/models',
    // ZCode needs a device id header on billing/inference endpoints.
    headers: (entry) => ({
      'X-Device-Mid': entry.deviceMid || '',
      'User-Agent': 'ZCode/3.14.3',
      'X-ZCode-App-Version': '3.14.3',
      'X-Platform': 'win32'
    }),
    fallbackModels: ZCODE_FALLBACK_MODELS
  },
  'minimax-code': {
    oauth: 'minimax-code',
    baseUrl: MINIMAX_ACCOUNT_HOST,
    chatPath: '/v1/chat/completions',
    modelsPath: '/v1/models',
    fallbackModels: MINIMAX_FALLBACK_MODELS
  },
  loomy: {
    oauth: 'loomy',
    baseUrl: LOOMY_API_BASE,
    chatPath: '/chat/completions',
    modelsPath: '/models',
    fallbackModels: LOOMY_FALLBACK_MODELS
  },
  lobsterai: {
    oauth: 'lobsterai',
    baseUrl: LOBSTERAI_API_BASE,
    chatPath: LOBSTERAI_CHAT_PATH,
    modelsPath: LOBSTERAI_MODELS_PATH,
    headers: () => lobsteraiHeaders(),
    fallbackModels: LOBSTERAI_FALLBACK_MODELS
  }
};

export { QODER_OPENAPI_BASE, QODER_USERINFO_PATH, GEMINI_LOAD_CODE_ASSIST_PATH, GEMINI_STREAM_PATH, GEMINI_MODELS_PATH, CLINE_RECOMMENDED_PATH };
