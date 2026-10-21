import { randomUUID } from 'node:crypto';
import { HttpError } from '../../core/errors.js';
import { AccountPool, sessionKeyFrom } from '../../core/pool.js';
import {
  extractCredentials,
  maskToken,
  profileFromToken
} from '../../core/credentials.js';
import { log, warn } from '../../core/logger.js';
import { prepareChatBody } from '../../protocol/openai.js';
import { WorkBuddyClient } from './client.js';
import { clientConfigFor, loginBaseUrl, pluginHeaders } from './config.js';
import { normalizeModel, staticModels } from './models.js';

/** How long an initiated browser login is allowed to be polled. */
const LOGIN_STATE_TTL_MS = 15 * 60 * 1000;

/**
 * WorkBuddy / CodeBuddy-style account channel.
 *
 * Supports N accounts per channel, sticky conversations, cooldown-aware
 * failover, desktop browser login and manual token import. The channel id is
 * arbitrary, so the same implementation can power multiple instances (for
 * example `workbuddy` and a `codebuddy` preset with another base URL).
 */
export class WorkBuddyChannel {
  constructor({ id, config, appConfig, persist }) {
    this.id = id;
    this.config = config;
    this.appConfig = appConfig;
    this.persist = persist;
    this.loginStates = new Map();
    this.loginInflight = new Map();
    this.cachedModels = [];
    this.pool = new AccountPool({
      entries: config.accounts,
      routing: config.routing,
      label: config.label || id,
      createClient: (entry) => this.#createClient(entry)
    });
  }

  get type() {
    return this.config.type || 'workbuddy';
  }

  /** Platform id sent to the auth-state endpoint (`workbuddy-ai` / `codebuddy`). */
  get platform() {
    return this.config.options?.platform || (this.type === 'codebuddy' ? 'codebuddy' : 'workbuddy-ai');
  }

  get label() {
    return this.config.label || this.id;
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  get capabilities() {
    return {
      login: true,
      manualCredentials: true,
      oauth: true,
      multipleAccounts: true
    };
  }

  #createClient(entry) {
    const client = new WorkBuddyClient(clientConfigFor(this.config, entry, this.appConfig.retry), (updated) => {
      this.#saveClient(entry.id, updated);
    });
    return client;
  }

  #saveClient(entryId, updated) {
    const entry = this.#findEntry(entryId);
    if (!entry) return;
    const upstream = updated.upstream;
    entry.accessToken = upstream.accessToken || '';
    entry.refreshToken = upstream.refreshToken || '';
    if (upstream.deviceToken) entry.deviceToken = upstream.deviceToken;
    if (upstream.userId) entry.userId = upstream.userId;
    this.persist();
  }

  #findEntry(id) {
    return (this.config.accounts || []).find((account) => account.id === id) || null;
  }

  primaryEntry() {
    return this.#findEntry('primary') || this.config.accounts?.[0] || null;
  }

  setConfig(config, appConfig = this.appConfig) {
    this.config = config;
    this.appConfig = appConfig;
    this.cachedModels = [];
    this.pool.setRouting(config.routing);
    this.pool.setEntries(config.accounts);
  }

  setEnabled(enabled) {
    this.config.enabled = Boolean(enabled);
  }

  async listModels({ force = false } = {}) {
    const clients = this.pool
      .all()
      .filter((account) => account.enabled)
      .map((account) => account.client);

    let models = null;
    for (const client of clients) {
      if (!client?.hasCredentials) continue;
      try {
        models = await client.fetchModels(force);
        if (models?.length) break;
      } catch {
        /* try the next account */
      }
    }

    if (!models?.length) {
      // Cached rows survive a transient /v3/config failure; the static roster
      // covers the "not logged in yet" case so the picker is never empty.
      models = clients.find((client) => client?.cachedModels?.length)?.cachedModels || staticModels();
    }

    this.cachedModels = models;
    return models.map((model) => normalizeModel(model, this.config));
  }

  aliases() {
    return this.config.models?.aliases || {};
  }

  resolveModel(id) {
    const requested = String(id || '').trim() || this.config.models?.default || '';
    return this.aliases()[requested] || requested;
  }

  hasModel(id) {
    if (!id) return false;
    if (this.aliases()[id]) return true;
    if (this.cachedModels?.some((model) => model.id === id)) return true;
    return staticModels().some((model) => model.id === id);
  }

  /** Raw upstream row, used to validate context-window overrides. */
  modelInfo(id) {
    return this.cachedModels?.find((model) => model.id === id) || null;
  }

  hasCredentials() {
    return this.pool
      .all()
      .some((account) => account.enabled && (account.client?.upstream?.accessToken || account.client?.upstream?.refreshToken));
  }

  prepareRequest(body, model) {
    return prepareChatBody(this.appConfig.prompt, body, model);
  }

  async chat({ body, options = {}, sessionKey = '' }) {
    return this.pool.chat(body, options, sessionKey);
  }

  sessionKey(headers, body) {
    return sessionKeyFrom(headers, body);
  }

  status() {
    const primary = this.pool.get('primary') || this.pool.all()[0];
    const profile = primary ? profileFromToken(primary.client?.upstream?.accessToken) : null;
    const expiresAt = Number(primary?.client?.tokenExpiresAt?.()) || 0;

    const accounts = this.pool.status((account) => {
      const client = account.client;
      const accountProfile = profileFromToken(client?.upstream?.accessToken);
      const accountExpires = Number(client?.tokenExpiresAt?.()) || 0;
      return {
        channel: this.id,
        channelLabel: this.label,
        username: accountProfile?.username || '',
        email: accountProfile?.email || '',
        expiresAt: accountExpires ? new Date(accountExpires * 1000).toISOString() : null,
        hasRefreshToken: Boolean(client?.upstream?.refreshToken),
        hasCredentials: Boolean(client?.upstream?.accessToken || client?.upstream?.refreshToken)
      };
    });

    return {
      id: this.id,
      type: this.type,
      label: this.label,
      enabled: this.enabled,
      capabilities: this.capabilities,
      configured: this.hasCredentials(),
      accountCount: accounts.length,
      modelCount: this.cachedModels?.length || 0,
      options: {
        baseUrl: this.config.options?.baseUrl || '',
        oauth: 'workbuddy'
      },
      accounts,
      user: profile
        ? { username: profile.username, email: profile.email, sub: profile.sub }
        : null,
      token: {
        expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
        expired: expiresAt ? expiresAt * 1000 < Date.now() : null,
        hasRefreshToken: Boolean(primary?.client?.upstream?.refreshToken),
        maskedAccessToken: maskToken(primary?.client?.upstream?.accessToken)
      },
      models: {
        default: this.config.models?.default || '',
        contextWindow: this.config.models?.contextWindow || {},
        aliases: this.aliases()
      },
      routing: {
        sessionAffinity: this.config.routing?.sessionAffinity !== false,
        affinityTtlMinutes: this.config.routing?.affinityTtlMinutes,
        failover: this.config.routing?.failover !== false,
        sessions: this.pool.sessionCount()
      }
    };
  }

  describe() {
    return {
      id: this.id,
      type: this.type,
      label: this.label,
      enabled: this.enabled,
      capabilities: this.capabilities,
      options: {
        baseUrl: this.config.options?.baseUrl || '',
        domain: this.config.options?.domain || '',
        product: this.config.options?.product || ''
      },
      accountCount: this.config.accounts?.length || 0,
      configured: this.hasCredentials(),
      models: {
        default: this.config.models?.default || '',
        aliases: this.aliases()
      }
    };
  }

  /** Called by /admin/start; at least one account must actually work. */
  async validate() {
    const candidates = this.pool
      .all()
      .filter(
        (account) =>
          account.enabled &&
          (account.client?.upstream?.accessToken || account.client?.upstream?.refreshToken)
      );

    if (!candidates.length) {
      return { ok: false, error: `${this.label} 尚未登录或没有可用凭据` };
    }

    let lastError = null;
    for (const account of candidates) {
      const client = account.client;
      if (client.upstream.refreshToken) {
        try {
          await client.refreshToken();
        } catch (error) {
          lastError = error;
          if (!client.upstream.accessToken) continue;
          warn(`[${this.label}] refresh during start failed, using existing access token: ${error.message}`);
        }
      }
      try {
        const data = await client.fetchProductConfigStrict();
        const models = Array.isArray(data.models) ? data.models : [];
        return { ok: true, account: account.label, models };
      } catch (error) {
        lastError = error;
      }
    }

    return {
      ok: false,
      error: `凭据校验失败：${lastError?.message || '没有可用账号'}`
    };
  }

  async applyCredentials(source, overrides = {}) {
    const creds = extractCredentials(typeof source === 'string' ? source : '');
    if (overrides.deviceToken) creds.deviceToken = String(overrides.deviceToken).trim();
    if (overrides.userId) creds.userId = String(overrides.userId).trim();

    if (!creds.accessToken && !creds.refreshToken) {
      throw new HttpError(
        400,
        '没有识别到 JWT。请粘贴 access token、refresh token，或包含 Authorization 的请求头。'
      );
    }

    const entry = this.primaryEntry();
    if (!entry) throw new HttpError(400, `${this.label} 没有主账号槽位`);

    const candidate = structuredClone(this.config);
    const candidateEntry = candidate.accounts.find((account) => account.id === entry.id);
    if (creds.accessToken) candidateEntry.accessToken = creds.accessToken;
    if (creds.refreshToken) candidateEntry.refreshToken = creds.refreshToken;
    if (creds.deviceToken) candidateEntry.deviceToken = creds.deviceToken;
    if (creds.userId) candidateEntry.userId = creds.userId;

    // A pasted access token for a different account must not inherit the old
    // account's refresh token.
    if (creds.accessToken && !creds.refreshToken) {
      const newSub = profileFromToken(creds.accessToken)?.sub;
      const oldSub = profileFromToken(entry.refreshToken)?.sub;
      if (newSub && oldSub && newSub !== oldSub) candidateEntry.refreshToken = '';
    }

    const temp = new WorkBuddyClient(clientConfigFor(candidate, candidateEntry, this.appConfig.retry), () => {});
    let warning = null;

    if (candidateEntry.refreshToken) {
      try {
        await temp.refreshToken();
      } catch (error) {
        warning = `刷新令牌不可用：${error.message}`;
        if (!candidateEntry.accessToken) throw new HttpError(400, warning);
      }
    }

    if (!candidateEntry.accessToken) throw new HttpError(400, '未能获得可用的 access token。');

    try {
      await temp.fetchProductConfigStrict();
    } catch (error) {
      throw new HttpError(400, `Token 校验失败：${error.message}`);
    }

    const profile = profileFromToken(candidateEntry.accessToken);
    if (!candidateEntry.userId && profile?.sub) candidateEntry.userId = profile.sub;

    entry.accessToken = candidateEntry.accessToken;
    entry.refreshToken = candidateEntry.refreshToken;
    entry.deviceToken = candidateEntry.deviceToken;
    entry.userId = candidateEntry.userId;

    this.persist();
    this.pool.setEntries(this.config.accounts);
    log(`[${this.label}] credentials saved for ${profile?.username || profile?.sub || 'unknown user'}`);

    const expiresAt = temp.tokenExpiresAt();
    return {
      warning,
      channel: this.id,
      user: profile ? { username: profile.username, email: profile.email, sub: profile.sub } : null,
      token: {
        expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
        hasRefreshToken: Boolean(entry.refreshToken)
      }
    };
  }

  async applyTokensToAccount(accountId, accessToken, refreshToken, deviceToken, label) {
    const entry = accountId ? this.#findEntry(accountId) : null;
    if (accountId && !entry) {
      throw new HttpError(404, '账号不存在，可能已被删除');
    }

    const maxConcurrency =
      Number(entry?.maxConcurrency) > 0
        ? Number(entry.maxConcurrency)
        : Number(this.config.routing?.defaultAccountConcurrency) || 2;

    const candidate = structuredClone(this.config);
    const candidateEntry = entry
      ? candidate.accounts.find((account) => account.id === entry.id)
      : {
          id: randomUUID(),
          label: label || '',
          enabled: true,
          maxConcurrency,
          accessToken: '',
          refreshToken: '',
          deviceToken: '',
          userId: ''
        };

    candidateEntry.accessToken = accessToken || entry?.accessToken || '';
    candidateEntry.refreshToken = refreshToken || entry?.refreshToken || '';
    candidateEntry.deviceToken = deviceToken || entry?.deviceToken || this.primaryEntry()?.deviceToken || '';
    candidateEntry.userId = entry?.userId || '';
    candidateEntry.maxConcurrency = maxConcurrency;

    const temp = new WorkBuddyClient(clientConfigFor(candidate, candidateEntry, this.appConfig.retry), () => {});
    let warning = null;

    if (candidateEntry.refreshToken) {
      try {
        await temp.refreshToken();
      } catch (error) {
        warning = `刷新令牌不可用：${error.message}`;
        if (!candidateEntry.accessToken) throw new HttpError(400, warning);
      }
    }

    if (!candidateEntry.accessToken) throw new HttpError(400, '未能获得可用的 access token。');

    try {
      await temp.fetchProductConfigStrict();
    } catch (error) {
      throw new HttpError(400, `Token 校验失败：${error.message}`);
    }

    const profile = profileFromToken(temp.upstream.accessToken);

    // Re-adding the same WorkBuddy account should update it instead of creating
    // a duplicate pool entry.
    let target = entry;
    const primary = this.primaryEntry();
    if (!target && profile?.sub) {
      if (primary?.userId === profile.sub) {
        primary.accessToken = temp.upstream.accessToken;
        primary.refreshToken = temp.upstream.refreshToken;
        primary.deviceToken = temp.upstream.deviceToken;
        primary.userId = profile.sub;
        this.persist();
        this.pool.setEntries(this.config.accounts);
        const expiresAt = temp.tokenExpiresAt();
        log(`[${this.label}] primary account updated (${profile.username || profile.sub})`);
        return {
          warning,
          channel: this.id,
          accountId: primary.id,
          label: primary.label,
          user: { username: profile.username, email: profile.email, sub: profile.sub },
          token: {
            expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
            hasRefreshToken: !!primary.refreshToken
          }
        };
      }
      target = (this.config.accounts || []).find((account) => account.userId === profile.sub) || null;
    }

    const data = {
      accessToken: temp.upstream.accessToken,
      refreshToken: temp.upstream.refreshToken,
      deviceToken: temp.upstream.deviceToken,
      userId: profile?.sub || target?.userId || '',
      label: target?.label || label || profile?.username || 'WorkBuddy 账号'
    };

    let id;
    if (target) {
      Object.assign(target, data);
      id = target.id;
    } else {
      id = randomUUID();
      this.config.accounts.push({ id, enabled: true, maxConcurrency, ...data });
    }

    this.persist();
    this.pool.setEntries(this.config.accounts, { rebuild: true });

    const expiresAt = temp.tokenExpiresAt();
    log(`[${this.label}] account ${data.label} saved (${profile?.username || profile?.sub || 'unknown'})`);

    return {
      warning,
      channel: this.id,
      accountId: id,
      label: data.label,
      user: profile
        ? { username: profile.username, email: profile.email, sub: profile.sub }
        : null,
      token: {
        expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
        hasRefreshToken: !!data.refreshToken
      }
    };
  }

  #pruneLoginStates() {
    const cutoff = Date.now() - LOGIN_STATE_TTL_MS;
    for (const [state, value] of this.loginStates) {
      if (value.at < cutoff) this.loginStates.delete(state);
    }
  }

  async loginStart({ createNew = false, accountId = 'primary', label = '' } = {}) {
    this.#pruneLoginStates();

    let targetAccount = null;
    if (!createNew && accountId !== 'primary') {
      targetAccount = this.#findEntry(accountId);
      if (!targetAccount) throw new HttpError(404, '账号不存在');
    }

    const deviceToken = targetAccount?.deviceToken || this.primaryEntry()?.deviceToken || '';
    const targetLabel = createNew ? String(label || '') : targetAccount?.label || this.primaryEntry()?.label || '主账号';
    const { base, origin } = loginBaseUrl(this.config);
    const version = this.config.options?.client?.ideVersion || '5.8.4';

    const url = `${base}/v2/plugin/auth/state?platform=${encodeURIComponent(this.platform)}&version=${encodeURIComponent(version)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: pluginHeaders(this.config, deviceToken),
      signal: AbortSignal.timeout(20000)
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (!response.ok || json?.code !== 0 || !json?.data?.state || !json?.data?.authUrl) {
      throw new HttpError(502, json?.msg || `创建登录会话失败（${response.status}）`);
    }

    const authUrl = String(json.data.authUrl);
    if (!authUrl.startsWith(`${origin}/`)) throw new HttpError(502, '上游返回了非预期的授权地址');

    this.loginStates.set(json.data.state, {
      at: Date.now(),
      accountId: createNew ? null : accountId,
      createNew,
      label: targetLabel,
      deviceToken
    });

    return {
      state: json.data.state,
      authUrl,
      mode: createNew ? 'new' : accountId,
      channel: this.id
    };
  }

  async loginStatus({ state = '' } = {}) {
    this.#pruneLoginStates();
    if (!state) throw new HttpError(400, '缺少 state');

    const session = this.loginStates.get(state);
    if (!session) throw new HttpError(400, '登录会话不存在或已过期，请重新发起登录');
    if (session.result) return { status: 'success', ...session.result };
    if (session.error) throw new HttpError(502, session.error);
    if (this.loginInflight.has(state)) return this.loginInflight.get(state);

    const task = (async () => {
      const { base } = loginBaseUrl(this.config);
      const response = await fetch(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
        headers: pluginHeaders(this.config, session.deviceToken),
        signal: AbortSignal.timeout(20000)
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* ignore */
      }

      if (json?.code === 11217) return { status: 'pending' };
      if (!response.ok || json?.code !== 0) {
        throw new HttpError(502, json?.msg || `获取登录 token 失败（${response.status}）`);
      }

      const accessToken = json?.data?.accessToken || json?.data?.access_token;
      const refreshToken = json?.data?.refreshToken || json?.data?.refresh_token;
      if (!accessToken) throw new HttpError(502, '登录已完成，但上游没有返回 access token');

      let result;
      if (session.createNew || (session.accountId && session.accountId !== 'primary')) {
        result = await this.applyTokensToAccount(
          session.accountId,
          accessToken,
          refreshToken,
          session.deviceToken,
          session.label
        );
      } else {
        const source = [
          `Authorization: Bearer ${accessToken}`,
          refreshToken ? `X-Refresh-Token: ${refreshToken}` : ''
        ]
          .filter(Boolean)
          .join('\n');
        result = await this.applyCredentials(source);
        result = {
          ...result,
          accountId: 'primary',
          label: this.primaryEntry()?.label || '主账号'
        };
      }
      return { status: 'success', ...result };
    })();

    this.loginInflight.set(state, task);
    try {
      const result = await task;
      if (result.status === 'success') session.result = result;
      return result;
    } catch (error) {
      session.error = error.message;
      throw error;
    } finally {
      this.loginInflight.delete(state);
    }
  }

  async refreshAccount(accountId = '') {
    const account = accountId ? this.pool.get(accountId) : this.pool.get('primary') || this.pool.all()[0];
    if (!account) throw new HttpError(404, '账号不存在');
    if (!account.client.upstream.refreshToken) throw new HttpError(400, '该账号没有刷新令牌');
    await account.client.refreshToken();
    return {
      channel: this.id,
      accountId: account.id,
      tokenExpiresAt: new Date(account.client.tokenExpiresAt() * 1000).toISOString()
    };
  }

  updateAccount({ id, label, maxConcurrency, enabled } = {}) {
    const entry = id === 'primary' ? this.primaryEntry() : this.#findEntry(id);
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
    this.pool.setEntries(this.config.accounts);
    return this.status();
  }

  toggleAccount({ id, enabled } = {}) {
    return this.updateAccount({ id, enabled });
  }

  removeAccount(id) {
    if (!id) throw new HttpError(400, '缺少账号 id');
    if (id === 'primary') throw new HttpError(400, '主账号不能删除，可以停用');
    const index = (this.config.accounts || []).findIndex((account) => account.id === id);
    if (index === -1) throw new HttpError(404, '账号不存在');

    this.config.accounts.splice(index, 1);
    this.persist();
    this.pool.dropAccountSessions(id);
    this.pool.setEntries(this.config.accounts);
    return this.status();
  }
}
