import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { HttpError } from '../../core/errors.js';
import { log, warn } from '../../core/logger.js';

/**
 * OpenRouter OAuth PKCE.
 *
 * OpenRouter publishes this flow specifically for third-party apps and
 * documents that localhost callbacks work on any port, so the gateway can own
 * the whole handshake: open the browser, catch the redirect on a loopback
 * port, exchange the code, and hand back a ready-to-use API key.
 *
 * Reference: https://openrouter.ai/docs/use-cases/oauth-pkce
 */

const AUTH_URL = process.env.WB2API_OPENROUTER_AUTH_URL || 'https://openrouter.ai/auth';
// Overridable so the offline suite can exercise the full handshake locally.
const EXCHANGE_URL =
  process.env.WB2API_OPENROUTER_EXCHANGE_URL || 'https://openrouter.ai/api/v1/auth/keys';
const STATE_TTL_MS = 10 * 60 * 1000;

/** code_verifier must be 43-128 chars of [A-Za-z0-9-._~]. */
function makeVerifier() {
  return randomBytes(48).toString('base64url');
}

function challengeFor(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

const RESULT_PAGE = (title, body, tone = '#5c6cf2') => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e14;
       color:#e7eaf0;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .card{max-width:420px;padding:32px 28px;border:1px solid #232936;border-radius:14px;
        background:#0d1118;text-align:center}
  .dot{width:10px;height:10px;border-radius:50%;background:${tone};display:inline-block;margin-right:8px}
  h1{font-size:16px;margin:0 0 10px}
  p{margin:0;color:#8b93a5}
</style></head>
<body><div class="card"><h1><span class="dot"></span>${title}</h1><p>${body}</p></div></body></html>`;

export class OpenRouterOAuth {
  constructor({ persist }) {
    this.id = 'openrouter';
    this.name = 'OpenRouter';
    this.kind = 'loopback';
    this.persist = persist;
    this.pending = new Map();
    this.server = null;
    this.port = 0;
    this.redirectBase = '';
  }

  get available() {
    return true;
  }

  #prune() {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [state, value] of this.pending) {
      if (value.at < cutoff) {
        this.pending.delete(state);
        value.server?.close?.();
      }
    }
  }

  /** Start a loopback listener on an ephemeral port; reused across logins. */
  async #ensureServer() {
    if (this.server) return { server: this.server, port: this.port };

    const server = http.createServer((req, res) => this.#handleCallback(req, res));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.server = server;
    this.port = server.address().port;
    this.redirectBase = `http://127.0.0.1:${this.port}/openrouter/callback`;
    log(`[openrouter] OAuth callback listening on ${this.redirectBase}`);
    return { server, port: this.port };
  }

  async #handleCallback(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/openrouter/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    const entry = this.pending.get(state);

    if (!entry) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(RESULT_PAGE('授权会话已失效', '请回到控制台重新点击「一键授权」。', '#e5677a'));
      return;
    }

    if (!code) {
      entry.status = 'error';
      entry.error = '授权被拒绝或未返回 code';
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(RESULT_PAGE('授权未完成', '没有拿到授权码，请回到控制台重试。', '#e5677a'));
      return;
    }

    entry.status = 'exchanging';
    try {
      const key = await this.#exchange(code, entry.verifier);
      entry.status = 'success';
      entry.apiKey = key;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        RESULT_PAGE(
          '授权成功',
          'API Key 已自动写入 Buddy2API，可以关闭这个页面并回到控制台。',
          '#64d6a4'
        )
      );
      log('[openrouter] OAuth key created and stored');
    } catch (error) {
      entry.status = 'error';
      entry.error = error.message;
      warn(`[openrouter] OAuth exchange failed: ${error.message}`);
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(RESULT_PAGE('换取 API Key 失败', escapeHtml(error.message), '#e5677a'));
    }
  }

  async #exchange(code, verifier) {
    const res = await fetch(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: 'S256'
      }),
      signal: AbortSignal.timeout(30000)
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }

    const key = json?.key || json?.data?.key || '';
    if (!res.ok || !key) {
      throw new Error(json?.error?.message || json?.message || `HTTP ${res.status} ${text.slice(0, 160)}`);
    }
    return key;
  }

  /** Create a pending session and return the URL the dashboard should open. */
  async start({ label = 'Buddy2API', channelId = 'openrouter' } = {}) {
    this.#prune();
    await this.#ensureServer();

    const verifier = makeVerifier();
    const challenge = challengeFor(verifier);
    const state = randomBytes(16).toString('hex');

    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set('callback_url', this.redirectBase);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('key_label', label);

    this.pending.set(state, {
      at: Date.now(),
      verifier,
      channelId,
      status: 'pending'
    });

    return { state, authUrl: authUrl.toString(), callbackUrl: this.redirectBase, channelId };
  }

  /** Poll a pending session; `success` carries the minted key exactly once. */
  poll(state) {
    this.#prune();
    const entry = this.pending.get(state);
    if (!entry) {
      throw new HttpError(404, '授权会话不存在或已过期，请重新发起授权');
    }
    if (entry.status === 'success') {
      const apiKey = entry.apiKey;
      // The key is delivered once, then the session is retired.
      this.pending.delete(state);
      return { status: 'success', apiKey, channelId: entry.channelId };
    }
    if (entry.status === 'error') {
      const error = entry.error;
      this.pending.delete(state);
      return { status: 'error', error, channelId: entry.channelId };
    }
    return { status: entry.status === 'exchanging' ? 'exchanging' : 'pending', channelId: entry.channelId };
  }

  close() {
    for (const entry of this.pending.values()) entry.server?.close?.();
    this.pending.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = 0;
    }
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}
