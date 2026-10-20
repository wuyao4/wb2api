import { createHash } from 'node:crypto';
import { WorkBuddyClient } from './workbuddy.js';
import { profileFromToken } from './credentials.js';
import { warn } from './logger.js';

export class AccountPool {
  constructor(config, primaryClient, persist) {
    this.config = config;
    this.primaryClient = primaryClient;
    this.persist = persist;
    this.sessions = new Map();
    this.additional = [];
    this.byId = new Map();
    this.primary = null;
    this.build();
  }

  build() {
    const config = this.config;
    this.primary = {
      id: 'primary',
      label: config.upstream.label || '主账号',
      enabled: config.upstream.enabled !== false,
      maxConcurrency: Number(config.upstream.maxConcurrency) || 1,
      client: this.primaryClient,
      isPrimary: true,
      lastUsed: 0
    };

    this.additional = (config.accounts || []).map((entry) => this.#makeAccount(entry));
    this.byId = new Map([
      ['primary', this.primary],
      ...this.additional.map((account) => [account.id, account])
    ]);
    this.pruneSessions();
  }

  #makeAccount(entry) {
    const clientConfig = structuredClone(this.config);
    const maxConcurrency =
      Number(entry.maxConcurrency) > 0
        ? Number(entry.maxConcurrency)
        : Number(this.config.routing?.defaultAccountConcurrency) || 2;

    clientConfig.upstream = {
      ...this.config.upstream,
      accessToken: entry.accessToken || '',
      refreshToken: entry.refreshToken || '',
      deviceToken: entry.deviceToken || this.config.upstream.deviceToken,
      userId: entry.userId || '',
      maxConcurrency,
      enabled: true,
      label: entry.label || ''
    };

    const client = new WorkBuddyClient(clientConfig, (updated) => {
      const target = (this.config.accounts || []).find((item) => item.id === entry.id);
      if (!target) return;
      target.accessToken = updated.upstream.accessToken;
      target.refreshToken = updated.upstream.refreshToken;
      if (updated.upstream.deviceToken) target.deviceToken = updated.upstream.deviceToken;
      if (updated.upstream.userId) target.userId = updated.upstream.userId;
      this.persist(this.config);
    });

    return {
      id: entry.id,
      label: entry.label || entry.id,
      enabled: entry.enabled !== false,
      maxConcurrency,
      client,
      isPrimary: false,
      lastUsed: 0
    };
  }

  setConfig(config, { rebuild = true } = {}) {
    this.config = config;
    if (rebuild) {
      this.build();
      return;
    }

    if (this.primary) {
      this.primary.label = config.upstream.label || '主账号';
      this.primary.enabled = config.upstream.enabled !== false;
      this.primary.maxConcurrency = Number(config.upstream.maxConcurrency) || 1;
    }
    for (const account of this.additional) {
      const entry = (config.accounts || []).find((item) => item.id === account.id);
      if (entry) {
        account.enabled = entry.enabled !== false;
        account.label = entry.label || account.label;
      }
    }
    this.pruneSessions();
  }

  all() {
    return this.primary ? [this.primary, ...this.additional] : this.additional;
  }

  get(id) {
    return this.byId.get(id);
  }

  #available(account) {
    return Boolean(account && account.enabled && account.client);
  }

  #load(account) {
    return account.client.inflightCount;
  }

  choose(sessionKey, exclude = new Set()) {
    const candidates = this.all().filter((account) => this.#available(account) && !exclude.has(account.id));
    if (!candidates.length) {
      const error = new Error('没有可用的 WorkBuddy 账号');
      error.status = 503;
      throw error;
    }

    const routing = this.config.routing || {};
    if (sessionKey && routing.sessionAffinity !== false) {
      const mapped = this.sessions.get(sessionKey);
      if (mapped) {
        const account = this.byId.get(mapped.accountId);
        if (this.#available(account) && !exclude.has(account.id)) {
          if (!account.client.isCoolingDown() || routing.affinityOnCooldown === 'wait') {
            this.touchSession(sessionKey, account);
            return account;
          }
          warn(
            `session ${String(sessionKey).slice(0, 14)} sticky account ${account.id} is cooling down, reassigning`
          );
        }
      }
    }

    const notCooling = candidates.filter((account) => !account.client.isCoolingDown());
    const pool = notCooling.length ? notCooling : candidates;
    pool.sort((a, b) => this.#load(a) - this.#load(b) || a.lastUsed - b.lastUsed);

    const chosen = pool[0];
    chosen.lastUsed = Date.now();
    if (sessionKey) this.touchSession(sessionKey, chosen);
    return chosen;
  }

  touchSession(key, account) {
    if (!key) return;
    this.sessions.delete(key);
    this.sessions.set(key, { accountId: account.id, at: Date.now() });
    this.pruneSessions();
  }

  dropAccountSessions(accountId) {
    for (const [key, value] of this.sessions) {
      if (value.accountId === accountId) this.sessions.delete(key);
    }
  }

  pruneSessions() {
    const routing = this.config.routing || {};
    const ttl = (Number(routing.affinityTtlMinutes) || 60) * 60000;
    const max = Number(routing.maxSessions) || 5000;
    const cutoff = Date.now() - ttl;

    for (const [key, value] of this.sessions) {
      if (value.at < cutoff) this.sessions.delete(key);
    }
    while (this.sessions.size > max) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  sessionKey(headers, body) {
    const direct =
      headers?.['x-session-id'] ||
      headers?.['x-conversation-id'] ||
      body?.session_id ||
      body?.conversation_id ||
      body?.user;
    if (direct) return `id:${String(direct)}`;

    const firstUser = Array.isArray(body?.messages)
      ? body.messages.find((message) => message?.role === 'user')
      : null;
    if (firstUser) {
      const text =
        typeof firstUser.content === 'string'
          ? firstUser.content
          : JSON.stringify(firstUser.content ?? '');
      if (text) {
        return `msg:${createHash('sha256').update(text.slice(0, 4096)).digest('hex')}`;
      }
    }
    return '';
  }

  async chat(body, options, sessionKey) {
    const routing = this.config.routing || {};
    const enabledCount = this.all().filter((account) => this.#available(account)).length;
    const attempts = routing.failover === false ? 1 : Math.min(2, Math.max(1, enabledCount));
    const tried = new Set();

    for (let index = 0; index < attempts; index += 1) {
      const account = this.choose(sessionKey, tried);
      tried.add(account.id);

      let slot;
      try {
        slot = await account.client.chat(body, options);
      } catch (error) {
        if (options?.signal?.aborted || index === attempts - 1) throw error;
        warn(`account ${account.label} failed before response, trying another account: ${error.message}`);
        continue;
      }

      if (slot.res.status !== 429 || index === attempts - 1) {
        return { ...slot, account };
      }

      await slot.res.text().catch(() => '');
      slot.release();
      warn(`account ${account.label} rate limited, trying another account`);
    }

    const error = new Error('所有 WorkBuddy 账号都不可用');
    error.status = 503;
    throw error;
  }

  status() {
    const sessionCounts = new Map();
    for (const value of this.sessions.values()) {
      sessionCounts.set(value.accountId, (sessionCounts.get(value.accountId) || 0) + 1);
    }

    return this.all().map((account) => {
      const profile = profileFromToken(account.client.upstream.accessToken);
      const expiresAt = account.client.tokenExpiresAt();
      const cooldownUntil = account.client.cooldownUntil;
      return {
        id: account.id,
        label: account.label,
        isPrimary: Boolean(account.isPrimary),
        enabled: account.enabled,
        username: profile?.username || '',
        email: profile?.email || '',
        expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
        hasRefreshToken: Boolean(account.client.upstream.refreshToken),
        maxConcurrency: account.maxConcurrency,
        load: account.client.inflightCount,
        coolingDown: account.client.isCoolingDown(),
        cooldownUntil:
          cooldownUntil && cooldownUntil > Date.now()
            ? new Date(cooldownUntil).toISOString()
            : null,
        sessions: sessionCounts.get(account.id) || 0
      };
    });
  }

  sessionCount() {
    return this.sessions.size;
  }
}
