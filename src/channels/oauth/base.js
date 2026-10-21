import http from 'node:http';
import { HttpError } from '../../core/errors.js';
import { log } from '../../core/logger.js';

/**
 * Shared plumbing for provider authorization flows.
 *
 * Every supported provider follows one of three shapes:
 *
 *   'device-code' — ask for a device code, show it, poll until approved.
 *                   No listening port, so nothing to leak or collide.
 *   'loopback'    — open the provider's page; it redirects to 127.0.0.1 and we
 *                   catch the code on an ephemeral port.
 *   'manual'      — no app-facing authorization API; the user creates a key in
 *                   the provider's dashboard (handled by the connect wizard).
 *
 * Providers are only listed here when they document an app-facing flow. Driving
 * a provider's login *form* is deliberately not supported: it would require
 * holding the user's account session and breaks on every UI change.
 */

/** Session lifetime; providers usually cap this themselves. */
export const SESSION_TTL_MS = 10 * 60 * 1000;

export const RESULT_PAGE = (title, body, tone = '#5c6cf2') => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e14;
       color:#e7eaf0;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .card{max-width:440px;padding:32px 28px;border:1px solid #232936;border-radius:14px;
        background:#0d1118;text-align:center}
  .dot{width:10px;height:10px;border-radius:50%;background:${tone};display:inline-block;margin-right:8px}
  h1{font-size:16px;margin:0 0 10px}
  p{margin:0;color:#8b93a5;word-break:break-word}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#c7cdff;font-size:13px}
</style></head>
<body><div class="card"><h1><span class="dot"></span>${escapeHtml(title)}</h1><p>${body}</p></div></body></html>`;

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

export function htmlResponse(res, status, title, body, tone) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(RESULT_PAGE(title, body, tone));
}

/**
 * An ephemeral loopback listener for `redirect_uri`-based flows.
 *
 * One listener serves every session of one provider; sessions are keyed by
 * `state`, so a stale or forged callback cannot complete someone else's login.
 */
export class LoopbackListener {
  constructor({ path = '/callback', name = 'oauth' } = {}) {
    this.path = path;
    this.name = name;
    this.server = null;
    this.port = 0;
    this.onCallback = null;
  }

  get redirectUri() {
    return this.port ? `http://127.0.0.1:${this.port}${this.path}` : '';
  }

  async ensure(handler, { port = 0 } = {}) {
    if (handler) this.onCallback = handler;
    if (this.server) return this.redirectUri;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== this.path) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      try {
        this.onCallback?.(url, res);
      } catch (error) {
        htmlResponse(res, 500, '处理失败', escapeHtml(error.message), '#e5677a');
      }
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });

    this.server = server;
    this.port = server.address().port;
    log(`[${this.name}] OAuth callback listening on ${this.redirectUri}`);
    return this.redirectUri;
  }

  close() {
    if (!this.server) return;
    this.server.close();
    this.server = null;
    this.port = 0;
  }
}

/** Poll interval handling that honours the provider's `slow_down` signal. */
export class PollScheduler {
  constructor(intervalMs, { minMs = 1000, stepMs = 1000, maxMs = 30000 } = {}) {
    this.intervalMs = Math.max(minMs, Number(intervalMs) || minMs);
    this.minMs = minMs;
    this.stepMs = stepMs;
    this.maxMs = maxMs;
  }

  /** Called when the provider asks us to back off. */
  slowDown() {
    this.intervalMs = Math.min(this.maxMs, this.intervalMs + this.stepMs);
    return this.intervalMs;
  }

  sleep(signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason || new Error('aborted'));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, this.intervalMs);
      const onAbort = () => {
        cleanup();
        reject(signal.reason || new Error('aborted'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** Throw a 502 with a provider-neutral prefix for authorization failures. */
export function authError(message, status = 502) {
  return new HttpError(status, message);
}

/**
 * Base class: session bookkeeping, polling contract and cleanup.
 *
 * Subclasses implement `begin()` and `complete()`; the base handles expiry,
 * one-shot delivery of the credential and error surfacing.
 */
export class OAuthProvider {
  constructor({ id, name, kind, persist }) {
    this.id = id;
    this.name = name;
    this.kind = kind;
    this.persist = persist;
    this.sessions = new Map();
    this.listener = null;
  }

  get available() {
    return true;
  }

  prune() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [state, session] of this.sessions) {
      if (session.at < cutoff && session.status !== 'success') {
        this.sessions.delete(state);
        session.controller?.abort?.();
      }
    }
  }

  /** Begin a flow; returns { state, authUrl, ...provider extras }. */
  async start() {
    throw new HttpError(501, `${this.name} 未实现 start()`);
  }

  /** Poll a flow; returns { status, credential?, error? }. */
  poll() {
    throw new HttpError(501, `${this.name} 未实现 poll()`);
  }

  /**
   * One-shot delivery: a credential is handed to the caller exactly once, then
   * the session is retired. Prevents replay from a stale dashboard tab.
   */
  takeResult(state) {
    this.prune();
    const session = this.sessions.get(state);
    if (!session) throw new HttpError(404, '授权会话不存在或已过期，请重新发起授权');

    if (session.status === 'success') {
      this.sessions.delete(state);
      return {
        status: 'success',
        credential: session.credential,
        account: session.account,
        channelId: session.channelId,
        extra: session.extra || {}
      };
    }
    if (session.status === 'error') {
      const error = session.error || '授权失败';
      this.sessions.delete(state);
      return { status: 'error', error, channelId: session.channelId };
    }
    return {
      status: session.status === 'exchanging' ? 'exchanging' : 'pending',
      channelId: session.channelId,
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      verificationUriComplete: session.verificationUriComplete,
      expiresAt: session.expiresAt || null
    };
  }

  close() {
    for (const session of this.sessions.values()) {
      session.controller?.abort?.();
    }
    this.sessions.clear();
    this.listener?.close?.();
    this.listener = null;
  }
}
