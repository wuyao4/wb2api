import { ChannelRegistry } from './channels/registry.js';
import { normalizeChannelConfig } from './channels/defaults.js';
import { OAuthRegistry } from './channels/oauth/index.js';
import { CONFIG_PATH, loadConfig, saveConfig } from './core/config.js';
import { HttpError } from './core/errors.js';
import { log, warn } from './core/logger.js';

/**
 * Composition root.
 *
 * Holds the mutable config (the dashboard edits it at runtime), the channel
 * registry, the OAuth provider registry and persistence. Everything else
 * receives a Runtime instead of importing the config singleton, which makes
 * adding a channel a local change.
 */
export class Runtime {
  constructor() {
    this.config = null;
    this.registry = null;
    this.oauth = null;
    /** Actual bound address, filled in by startServer (port 0 picks one). */
    this.listening = null;
    this.reload();
  }

  reload() {
    this.config = loadConfig();
    this.registry = new ChannelRegistry(this.config, {
      persist: () => this.persist(),
      retry: this.config.retry
    });
    if (!this.oauth) this.oauth = new OAuthRegistry({ persist: () => this.persist() });

    if (this.config.__migratedFromLegacy) {
      log('legacy single-channel config detected; migrated to config.channels (saved on next change)');
    }
    return this.config;
  }

  persist() {
    try {
      saveConfig(this.config);
    } catch (error) {
      warn(`could not persist config: ${error.message}`);
    }
  }

  get configPath() {
    return CONFIG_PATH;
  }

  get running() {
    return Boolean(this.config.server.running);
  }

  setRunning(value) {
    this.config.server.running = Boolean(value);
    this.persist();
  }

  getChannel(id) {
    return this.registry.get(id);
  }

  getChannelOrThrow(id) {
    const channel = this.registry.get(id);
    if (!channel) throw new HttpError(404, `渠道不存在：${id}`);
    return channel;
  }

  channels() {
    return this.registry.channels;
  }

  enabledChannels() {
    return this.registry.enabledChannels();
  }

  defaultChannel() {
    return this.registry.defaultChannel();
  }

  statuses() {
    return this.registry.statuses();
  }

  describes() {
    return this.registry.describes();
  }

  resolveModel(id) {
    return this.registry.resolveModel(id);
  }

  listModels(options) {
    return this.registry.listModels(options);
  }

  /** Whether the current channel count makes `channel/model` the public form. */
  usesNamespace() {
    const mode = this.config.routing?.namespace || 'auto';
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return this.enabledChannels().length > 1;
  }

  /** Format an id the same way /v1/models will expose it. */
  formatModelId(channelId, modelId) {
    return this.usesNamespace() ? `${channelId}/${modelId}` : modelId;
  }

  /** Pick the channel that dashboard-style (unqualified) calls should target. */
  pickChannel(id) {
    if (id) return this.getChannelOrThrow(id);
    const channel = this.defaultChannel();
    if (!channel) throw new HttpError(404, '还没有配置任何渠道');
    return channel;
  }

  addChannel(id, raw) {
    if (this.config.channels[id]) throw new HttpError(409, `渠道 ${id} 已存在`);
    const channel = normalizeChannelConfig(id, raw);
    this.config.channels[id] = channel;
    this.persist();
    this.registry.build();
    log(`channel ${id} (${channel.type}) added`);
    return this.getChannel(id);
  }

  updateChannel(id, patch = {}) {
    const current = this.config.channels[id];
    if (!current) throw new HttpError(404, `渠道不存在：${id}`);
    if (patch.type && patch.type !== current.type) {
      throw new HttpError(400, '渠道类型不可修改，请新建渠道');
    }

    const next = structuredClone(current);
    if (patch.label !== undefined) next.label = String(patch.label).slice(0, 60);
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);

    if (patch.options && typeof patch.options === 'object') {
      next.options = { ...next.options, ...patch.options };
      if (patch.options.models !== undefined && !Array.isArray(patch.options.models)) {
        throw new HttpError(400, 'options.models 必须是数组');
      }
      // Keep the primary generic account in sync with the channel-level key.
      if (patch.options.apiKey !== undefined) {
        const primary = (next.accounts || []).find((account) => account.id === 'primary') || next.accounts?.[0];
        if (primary) primary.apiKey = String(patch.options.apiKey || '');
      }
    }

    if (patch.models && typeof patch.models === 'object') {
      next.models = { ...next.models, ...patch.models };
    }

    if (patch.routing && typeof patch.routing === 'object') {
      next.routing = { ...next.routing, ...patch.routing };
    }

    // Never let an update replace a complete account list implicitly.
    if (Array.isArray(patch.accounts)) next.accounts = patch.accounts;

    const normalized = normalizeChannelConfig(id, next);
    this.config.channels[id] = normalized;

    const channel = this.getChannel(id);
    if (channel?.setConfig) {
      channel.setConfig(normalized, this.config);
    } else {
      this.registry.build();
    }

    this.persist();
    return this.getChannel(id);
  }

  removeChannel(id) {
    if (!this.config.channels[id]) throw new HttpError(404, `渠道不存在：${id}`);
    delete this.config.channels[id];
    this.persist();
    this.registry.build();
    return true;
  }

  toggleChannel(id, enabled) {
    return this.updateChannel(id, { enabled });
  }

  /** Global model routing update (aliases / default / namespace). */
  updateRouting(patch = {}) {
    this.config.routing = { ...this.config.routing, ...patch };
    this.persist();
    return this.config.routing;
  }

  /** Store an API key on a generic channel and rebuild its client pool. */
  setChannelApiKey(id, apiKey, { persist = true } = {}) {
    const channel = this.getChannelOrThrow(id);
    if (!channel.setApiKey) throw new HttpError(400, `${channel.label} 不支持写入 API Key`);
    channel.setApiKey(apiKey);
    channel.setConfig?.(this.config.channels[id], this.config);
    if (persist) this.persist();
    return channel;
  }

  /**
   * Store or replace an OAuth credential on a channel.
   *
   * OAuth channels authenticate with a token (plus refresh state), so the
   * credential lives in `accounts[]` rather than `options.apiKey`.
   */
  setChannelAccount(id, account, { persist = true } = {}) {
    const channel = this.getChannelOrThrow(id);
    const raw = this.config.channels[id];
    raw.accounts = Array.isArray(raw.accounts) ? raw.accounts : [];

    const index = raw.accounts.findIndex((entry) => entry.id === account.id);
    if (index >= 0) raw.accounts[index] = { ...raw.accounts[index], ...account };
    else raw.accounts.push(account);

    // Mirror the token into options.apiKey so the generic client can send it.
    if (account.accessToken) {
      raw.options = { ...raw.options, apiKey: account.accessToken };
    }

    channel.setConfig?.(raw, this.config);
    if (persist) this.persist();
    return channel;
  }

  close() {
    this.oauth?.close?.();
  }
}
