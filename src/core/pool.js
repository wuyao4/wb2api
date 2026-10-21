import { createHash } from 'node:crypto';
import { HttpError } from './errors.js';
import { warn } from './logger.js';

/**
 * Account scheduling shared by every channel.
 *
 * A channel supplies `entries` (plain account configs) and a `createClient`
 * factory. A client only needs to expose:
 *   chat(body, options) -> { res, model, release }
 *   inflightCount
 *   isCoolingDown()
 *   cooldownUntil
 *
 * Everything else — sticky sessions, cooldown-aware selection, one-hop
 * failover — lives here so a new channel does not reimplement it.
 */
export class AccountPool {
  constructor({ entries = [], createClient, routing = {}, label = '渠道' }) {
    this.createClient = createClient;
    this.routing = routing;
    this.label = label;
    this.sessions = new Map();
    this.accounts = [];
    this.byId = new Map();
    this.setEntries(entries);
  }

  setEntries(entries = [], { rebuild = true } = {}) {
    const previous = new Map(this.accounts.map((account) => [account.id, account]));
    this.accounts = (entries || []).map((entry) => {
      const id = String(entry.id || 'primary');
      const existing = previous.get(id);
      const client = rebuild || !existing ? this.createClient(entry) : existing.client;
      return {
        id,
        label: String(entry.label || existing?.label || id),
        enabled: entry.enabled !== false,
        maxConcurrency: Math.max(1, Number(entry.maxConcurrency) || 1),
        client,
        isPrimary: id === 'primary' || Boolean(entry.isPrimary),
        lastUsed: existing?.lastUsed || 0
      };
    });
    this.byId = new Map(this.accounts.map((account) => [account.id, account]));
    this.pruneSessions();
  }

  setRouting(routing = {}) {
    this.routing = routing;
    this.pruneSessions();
  }

  all() {
    return this.accounts;
  }

  get(id) {
    return this.byId.get(id);
  }

  #available(account) {
    return Boolean(account && account.enabled && account.client);
  }

  #load(account) {
    return Number(account.client?.inflightCount) || 0;
  }

  #cooling(account) {
    return Boolean(account.client?.isCoolingDown?.());
  }

  choose(sessionKey, exclude = new Set()) {
    const candidates = this.accounts.filter((account) => this.#available(account) && !exclude.has(account.id));
    if (!candidates.length) {
      throw new HttpError(503, `${this.label} 没有可用账号`);
    }

    const routing = this.routing || {};
    if (sessionKey && routing.sessionAffinity !== false) {
      const mapped = this.sessions.get(sessionKey);
      if (mapped) {
        const account = this.byId.get(mapped.accountId);
        if (this.#available(account) && !exclude.has(account.id)) {
          if (!this.#cooling(account) || routing.affinityOnCooldown === 'wait') {
            this.touchSession(sessionKey, account);
            return account;
          }
          warn(`session ${String(sessionKey).slice(0, 14)} sticky account ${account.id} is cooling down, reassigning`);
        }
      }
    }

    const notCooling = candidates.filter((account) => !this.#cooling(account));
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
    const routing = this.routing || {};
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

  async chat(body, options = {}, sessionKey = '') {
    const routing = this.routing || {};
    const enabledCount = this.accounts.filter((account) => this.#available(account)).length;
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

    throw new HttpError(503, `${this.label} 的所有账号都不可用`);
  }

  sessionCount() {
    return this.sessions.size;
  }

  status(enrich) {
    const sessionCounts = new Map();
    for (const value of this.sessions.values()) {
      sessionCounts.set(value.accountId, (sessionCounts.get(value.accountId) || 0) + 1);
    }

    return this.accounts.map((account) => {
      const cooldownUntil = Number(account.client?.cooldownUntil) || 0;
      const base = {
        id: account.id,
        label: account.label,
        isPrimary: Boolean(account.isPrimary),
        enabled: account.enabled,
        maxConcurrency: account.maxConcurrency,
        load: Number(account.client?.inflightCount) || 0,
        coolingDown: this.#cooling(account),
        cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null,
        sessions: sessionCounts.get(account.id) || 0
      };
      const extra = typeof enrich === 'function' ? enrich(account, base) : null;
      return extra ? { ...base, ...extra } : base;
    });
  }
}

/** Stable conversation key: explicit header/field first, first user message next. */
export function sessionKeyFrom(headers = {}, body = {}) {
  const direct =
    headers['x-session-id'] ||
    headers['x-conversation-id'] ||
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
