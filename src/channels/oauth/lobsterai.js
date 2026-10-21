import { randomUUID } from 'node:crypto';
import { log, warn } from '../../core/logger.js';
import { HttpError } from '../../core/errors.js';
import { LoopbackListener, OAuthProvider, authError, escapeHtml, htmlResponse } from './base.js';

/**
 * LobsterAI (有道) — authorization code on a loopback callback.
 *
 * The official client opens `{portal}/portal#/login?...` with a `redirect_uri`
 * pointing at `127.0.0.1`, so the same two-step handshake works here: open the
 * portal, catch the code on an ephemeral port, exchange it for a token.
 *
 * Verified live: the portal answers 200 with its login page, and
 * `POST /api/auth/exchange` answers
 * `{"code":40102,"message":"无效或已过期的授权码"}` for a bad code — both the
 * endpoint and the envelope shape are confirmed.
 *
 * The exchange body needs `firstKeyfrom` / `latestKeyfrom` / `uuid` / `version`
 * in addition to the code; the client sends them and so do we.
 */

const PORTAL_BASE = 'https://lobsterai.youdao.com';
const API_BASE = 'https://lobsterai-server.youdao.com';

const EXCHANGE_PATH = '/api/auth/exchange';
const REFRESH_PATH = '/api/auth/refresh';
const MODELS_PATH = '/api/models/available';
const CHAT_PATH = '/api/proxy/v1/chat/completions';
const CALLBACK_PATH = '/auth/callback';

const CLIENT_VERSION = '2026.9.4';

/** Capability declarations the model list gates on. */
const CLIENT_CAPABILITIES = 'kimi-k3-agentic-v1,thinking-v1';

export const LOBSTERAI_FALLBACK_MODELS = [
  { id: 'kimi-k3', name: 'Kimi K3' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'glm-5.3', name: 'GLM-5.3' }
];

function anonymousHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': `LobsterAI/${CLIENT_VERSION}`,
    'X-LobsterAI-Client-Version': CLIENT_VERSION,
    'X-LobsterAI-Client-Capabilities': CLIENT_CAPABILITIES
  };
}

export class LobsteraiOAuth extends OAuthProvider {
  constructor({ persist }) {
    super({ id: 'lobsterai', name: 'LobsterAI', kind: 'loopback', persist });
    this.listener = new LoopbackListener({ path: CALLBACK_PATH, name: 'lobsterai' });
  }

  async start({ channelId = 'lobsterai' } = {}) {
    this.prune();

    const state = randomUUID().replace(/-/g, '');
    const redirectUri = await this.listener.ensure((url, res) => this.#handleCallback(url, res));

    const session = {
      at: Date.now(),
      status: 'pending',
      channelId,
      redirectUri,
      // `firstKeyfrom` is the first-login timestamp and must be echoed on both
      // exchange and refresh; capture it once per login.
      firstKeyfrom: String(Date.now()),
      uuid: randomUUID(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      controller: new AbortController()
    };
    this.sessions.set(state, session);

    const authUrl = `${PORTAL_BASE}/portal#/login?${new URLSearchParams({
      redirect_uri: redirectUri,
      state,
      client_version: CLIENT_VERSION
    }).toString()}`;

    return {
      state,
      authUrl,
      redirectUri,
      mode: 'loopback',
      channelId,
      expiresAt: session.expiresAt,
      note: '在浏览器完成有道账号登录；本页会自动继续。'
    };
  }

  async #handleCallback(url, res) {
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    const error = url.searchParams.get('error') || '';
    const session = this.sessions.get(state);

    if (!session) {
      htmlResponse(res, 400, '授权会话已失效', '请回到控制台重新发起授权。', '#e5677a');
      return;
    }
    if (error) {
      session.status = 'error';
      session.error = `LobsterAI 返回错误：${escapeHtml(error)}`;
      htmlResponse(res, 400, '授权未完成', escapeHtml(session.error), '#e5677a');
      return;
    }
    if (!code) {
      session.status = 'error';
      session.error = '回调没有携带授权码';
      htmlResponse(res, 400, '授权未完成', '回调没有携带授权码，请回到控制台重试。', '#e5677a');
      return;
    }

    session.status = 'exchanging';
    try {
      const credential = await this.#exchange(code, session);
      session.status = 'success';
      session.credential = credential;
      session.account = {
        label: credential.name || 'LobsterAI',
        username: credential.name || credential.userId
      };
      htmlResponse(res, 200, '授权成功', 'Token 已写入 Buddy2API，可以关闭本页。', '#64d6a4');
      log('[lobsterai] authorization completed');
    } catch (error) {
      session.status = 'error';
      session.error = error.message;
      warn(`[lobsterai] authorization failed: ${error.message}`);
      htmlResponse(res, 502, '换取 Token 失败', escapeHtml(error.message), '#e5677a');
    }
  }

  async #exchange(code, session) {
    const res = await fetch(`${API_BASE}${EXCHANGE_PATH}`, {
      method: 'POST',
      headers: anonymousHeaders(),
      body: JSON.stringify({
        authCode: code,
        firstKeyfrom: session.firstKeyfrom,
        latestKeyfrom: String(Date.now()),
        uuid: session.uuid,
        version: CLIENT_VERSION
      }),
      signal: session.controller.signal
    });
    const payload = await res.json().catch(() => null);

    const code_ = payload?.code;
    if (!res.ok || (code_ !== undefined && code_ !== 0)) {
      throw authError(
        `LobsterAI 交换失败${payload?.message ? `：${payload.message}` : `（HTTP ${res.status}）`}`
      );
    }

    const data = payload?.data || payload?.result || payload;
    const accessToken = String(data?.accessToken || data?.access_token || '');
    if (!accessToken) throw authError('LobsterAI 交换响应缺少访问令牌');

    const expiresAt = Number(data?.expiresAt || data?.expires_at || 0);
    return {
      accessToken,
      refreshToken: String(data?.refreshToken || data?.refresh_token || ''),
      expiresAt: expiresAt > 0 ? (expiresAt < 1e12 ? expiresAt * 1000 : expiresAt) : 0,
      userId: String(data?.userId || data?.user_id || data?.uuid || ''),
      name: String(data?.nickname || data?.userName || data?.name || '')
    };
  }

  poll(state) {
    return this.takeResult(state);
  }

  async refresh(credential) {
    if (!credential?.refreshToken) throw new HttpError(400, '该账号没有刷新令牌');
    const res = await fetch(`${API_BASE}${REFRESH_PATH}`, {
      method: 'POST',
      headers: anonymousHeaders(),
      body: JSON.stringify({
        refreshToken: credential.refreshToken,
        firstKeyfrom: credential.firstKeyfrom || String(Date.now()),
        latestKeyfrom: String(Date.now()),
        uuid: credential.uuid || randomUUID(),
        version: CLIENT_VERSION
      }),
      signal: AbortSignal.timeout(30000)
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || (payload?.code !== undefined && payload.code !== 0)) {
      throw authError(`LobsterAI 续期失败（HTTP ${res.status}）`);
    }
    const data = payload?.data || payload?.result || payload;
    const accessToken = String(data?.accessToken || data?.access_token || '');
    if (!accessToken) throw authError('LobsterAI 续期响应缺少访问令牌');
    return {
      ...credential,
      accessToken,
      refreshToken: String(data?.refreshToken || data?.refresh_token || credential.refreshToken)
    };
  }
}

export {
  API_BASE as LOBSTERAI_API_BASE,
  PORTAL_BASE as LOBSTERAI_PORTAL_BASE,
  CHAT_PATH as LOBSTERAI_CHAT_PATH,
  MODELS_PATH as LOBSTERAI_MODELS_PATH,
  anonymousHeaders as lobsteraiHeaders
};
