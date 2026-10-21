import { AccountPool, sessionKeyFrom } from '../../core/pool.js';
import { HttpError } from '../../core/errors.js';
import { maskToken } from '../../core/credentials.js';
import { warn } from '../../core/logger.js';
import { prepareCompatBody } from '../../protocol/openai.js';
import { presetById } from '../catalog.js';
import { OpenAICompatClient } from './client.js';

function staticModels(options = {}) {
  return (Array.isArray(options.models) ? options.models : [])
    .map((row) => (typeof row === 'string' ? { id: row, name: row } : row))
    .filter((row) => row && row.id);
}

function normalizeModel(row, channelConfig, label) {
  const contextLength =
    Number(row.context_length ?? row.context_window ?? row.max_context_length ?? 0) ||
    Number(channelConfig.models?.contextWindow?.default) ||
    null;
  const maxContext = Number(row.max_context_length ?? row.max_input_tokens ?? contextLength) || contextLength;

  return {
    id: String(row.id),
    object: 'model',
    created: Number(row.created) || Math.floor(Date.now() / 1000),
    owned_by: row.owned_by || label,
    name: row.name || row.display_name || String(row.id),
    context_length: contextLength,
    context_window: contextLength,
    max_context_length: maxContext,
    max_input_tokens: maxContext,
    supported_context_lengths: row.supported_context_lengths || (maxContext ? [maxContext] : []),
    default_context_length: row.default_context_length ?? contextLength,
    max_output_tokens: row.max_output_tokens ?? row.max_completion_tokens ?? null,
    capabilities: {
      vision: Boolean(row.capabilities?.vision ?? row.supports_images),
      tools: Boolean(row.capabilities?.tools ?? row.supports_tools),
      reasoning: Boolean(row.capabilities?.reasoning ?? row.supports_reasoning)
    }
  };
}

/**
 * Generic OpenAI-compatible channel.
 *
 * This is the extension point for the long tail of providers: anything that
 * speaks `POST /chat/completions` + `GET /models` works here. Presets for
 * well-known gateways live in `src/channels/catalog.js`.
 */
export class OpenAICompatibleChannel {
  constructor({ id, config, appConfig, persist }) {
    this.id = id;
    this.config = config;
    this.appConfig = appConfig;
    this.persist = persist;
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
    return this.config.type || 'openai-compatible';
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
      manualCredentials: true,
      oauth: false,
      multipleAccounts: true
    };
  }

  #accounts() {
    if (Array.isArray(this.config.accounts) && this.config.accounts.length) return this.config.accounts;
    return [
      {
        id: 'primary',
        label: this.label,
        enabled: true,
        maxConcurrency: this.config.options?.maxConcurrency || 4,
        apiKey: this.config.options?.apiKey || ''
      }
    ];
  }

  #createClient(entry) {
    return new OpenAICompatClient({
      options: {
        ...this.config.options,
        // Per-channel 429 fallbacks live beside the model list, not in options.
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
    const staticRows = staticModels(this.config.options);
    const clients = this.pool
      .all()
      .filter((account) => account.enabled)
      .map((account) => account.client);

    let rows = null;
    if (this.config.options?.baseUrl) {
      for (const client of clients) {
        try {
          rows = await client.fetchModels(force);
          if (rows?.length) break;
        } catch (error) {
          // A dashboard refresh hits every channel; log a broken upstream at
          // most once every five minutes instead of on every poll.
          if (Date.now() - this.lastModelWarnAt > 300000) {
            this.lastModelWarnAt = Date.now();
            warn(`[${this.label}] model list failed: ${error.message}`);
          }
        }
      }
    }

    if (!rows?.length) {
      rows = clients.find((client) => client?.cachedModels?.length)?.cachedModels || staticRows;
    }

    this.cachedModels = rows;
    return rows.map((row) => normalizeModel(row, this.config, this.label));
  }

  hasModel(id) {
    if (!id) return false;
    if (this.aliases()[id]) return true;
    if (this.cachedModels?.some((row) => String(row.id) === id)) return true;
    return staticModels(this.config.options).some((row) => String(row.id) === id);
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
      const key = account.client?.account?.apiKey || this.config.options?.apiKey || '';
      return {
        channel: this.id,
        channelLabel: this.label,
        username: key ? `…${String(key).slice(-4)}` : this.label,
        email: '',
        expiresAt: null,
        hasRefreshToken: false,
        hasCredentials: Boolean(key) || Boolean(this.config.options?.baseUrl),
        maskedApiKey: maskToken(key)
      };
    });

    const key = this.config.options?.apiKey || this.config.accounts?.find((a) => a.apiKey)?.apiKey || '';
    const preset = presetById(this.config.options?.preset);

    return {
      id: this.id,
      type: this.type,
      label: this.label,
      enabled: this.enabled,
      capabilities: this.capabilities,
      configured: Boolean(this.config.options?.baseUrl),
      accountCount: accounts.length,
      modelCount: this.cachedModels?.length || 0,
      // The channel list renders credential state from here; omitting it made
      // every keyed channel look keyless.
      options: {
        baseUrl: this.config.options?.baseUrl || '',
        hasKey: Boolean(key),
        maskedKey: maskToken(key),
        preset: preset?.id || '',
        keyless: preset ? !preset.apiKeyRequired : null
      },
      accounts,
      user: null,
      token: {
        expiresAt: null,
        expired: null,
        hasRefreshToken: false,
        maskedAccessToken: ''
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
    const key = this.config.options?.apiKey || this.config.accounts?.find((a) => a.apiKey)?.apiKey || '';
    const preset = presetById(this.config.options?.preset);
    return {
      id: this.id,
      type: this.type,
      label: this.label,
      enabled: this.enabled,
      capabilities: this.capabilities,
      options: {
        baseUrl: this.config.options?.baseUrl || '',
        modelsPath: this.config.options?.modelsPath || '/models',
        chatPath: this.config.options?.chatPath || '/chat/completions',
        hasKey: Boolean(key),
        maskedKey: maskToken(key),
        preset: preset?.id || '',
        keyless: preset ? !preset.apiKeyRequired : null,
        apiKeyUrl: preset?.apiKeyUrl || '',
        models: staticModels(this.config.options).map((row) => row.id)
      },
      accountCount: this.config.accounts?.length || 0,
      // A channel with a base URL but no key can still be configured (keyless
      // or local runtimes); `hasKey` is what the UI shows separately.
      configured: Boolean(this.config.options?.baseUrl),
      models: {
        default: this.config.models?.default || '',
        aliases: this.aliases()
      }
    };
  }

  async validate() {
    if (!this.config.options?.baseUrl) {
      return { ok: false, error: `${this.label} 尚未配置 baseUrl` };
    }

    const preset = presetById(this.config.options?.preset);
    const key = this.config.options?.apiKey || this.config.accounts?.find((a) => a.apiKey)?.apiKey || '';
    if (preset?.apiKeyRequired && !key) {
      return {
        ok: false,
        error: `${this.label} 的对话接口需要 API Key（部分上游的 /models 是公开的，所以列表能读不代表能用）${preset.apiKeyUrl ? `，获取地址：${preset.apiKeyUrl}` : ''}`
      };
    }

    if (staticModels(this.config.options).length) return { ok: true };

    const models = await this.listModels();
    if (!models.length) {
      return { ok: false, error: `${this.label} 没有可用模型（/models 为空，且未配置静态模型清单）` };
    }
    return { ok: true, models };
  }

  /** Replace the API key without touching other fields. */
  setApiKey(apiKey) {
    const value = String(apiKey || '').trim();
    this.config.options.apiKey = value;
    const primary = (this.config.accounts || []).find((account) => account.id === 'primary');
    if (primary) primary.apiKey = value;
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
