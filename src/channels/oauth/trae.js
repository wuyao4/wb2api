import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { log, warn } from '../../core/logger.js';
import { LoopbackListener, OAuthProvider, authError, escapeHtml, htmlResponse } from './base.js';

/**
 * TRAE (ByteDance) — authorization code + PKCE on a loopback callback.
 *
 * TRAE forces the redirect to `http://127.0.0.1:18080/authorize`. The port is
 * fixed by the provider, so the listener tries 18080 first and falls back to an
 * ephemeral port when it is already taken (the browser still works: the
 * redirect_uri is derived from whatever port we actually bound).
 *
 * Verified live: the authorization portal answers 200 and the exchange endpoint
 * answers a structured 400 (`invalid parameter`) rather than 404, confirming the
 * path exists.
 *
 * Note the exchange is a two-step affair: the callback yields an authCode which
 * is exchanged for tokens, then `GetUserInfo` resolves the account identity.
 */

const PORTAL = 'https://www.trae.cn';
const OAUTH_HOST = 'https://api.trae.com.cn';
const AGENT_HOST = 'https://trae-api-cn.mchost.guru';

const EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken';
const USER_INFO_PATH = '/cloudide/api/v3/trae/GetUserInfo';
const CHAT_PATH = '/api/agent/v3/llm_utils_chat';
const MODELS_PATH = '/api/ide/v1/get_detail_param';

/** TRAE pins this port; we try it first and fall back when busy. */
const PREFERRED_PORT = 18080;

export const TRAE_FALLBACK_MODELS = [
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek V4 Flash Official' },
  { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro' },
  { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash' },
  { id: 'Doubao-Seed-2.1-Pro', name: 'Doubao Seed 2.1 Pro' },
  { id: 'Doubao-Seed-2.1-Turbo', name: 'Doubao Seed 2.1 Turbo' },
  { id: 'Doubao-Seed-2.0-Code', name: 'Doubao Seed 2.0 Code' },
  { id: 'kimi-k3', name: 'Kimi K3' },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'glm-5-turbo', name: 'GLM-5 Turbo' },
  { id: 'minimax-m3', name: 'MiniMax M3' },
  { id: 'qwen-3.7-plus', name: 'Qwen 3.7 Plus' }
];

function makePkce() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export class TraeOAuth extends OAuthProvider {
  constructor({ persist }) {
    super({ id: 'trae', name: 'TRAE', kind: 'loopback', persist });
    this.listener = new LoopbackListener({ path: '/authorize', name: 'trae' });
  }

  async start({ channelId = 'trae' } = {}) {
    this.prune();

    const pkce = makePkce();
    const state = randomUUID().replace(/-/g, '');

    const redirectUri = await this.#ensureListener();
    const session = {
      at: Date.now(),
      status: 'pending',
      channelId,
      verifier: pkce.verifier,
      redirectUri,
      machineId: randomUUID(),
      deviceId: randomUUID(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      controller: new AbortController()
    };
    this.sessions.set(state, session);

    const authUrl = `${PORTAL}/authorization?${new URLSearchParams({
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state
    }).toString()}`;

    return {
      state,
      authUrl,
      redirectUri,
      mode: 'loopback',
      channelId,
      expiresAt: session.expiresAt,
      note: '在浏览器完成 TRAE 登录；本页会自动继续。'
    };
  }

  async #ensureListener() {
    const handler = (url, res) => this.#handleCallback(url, res);

    // TRAE prefers 18080. Bind it explicitly first so the redirect_uri matches
    // what their portal expects when the port is free.
    if (!this.listener.port) {
      try {
        await this.listener.ensure(handler, { port: PREFERRED_PORT });
        return this.listener.redirectUri;
      } catch (error) {
        warn(`[trae] port ${PREFERRED_PORT} unavailable (${error.message}), using an ephemeral port`);
      }
    }
    return this.listener.ensure(handler);
  }

  async #handleCallback(url, res) {
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || url.searchParams.get('authCode') || '';
    const token = url.searchParams.get('token') || '';
    const error = url.searchParams.get('error') || '';
    const session = this.sessions.get(state);

    if (!session) {
      htmlResponse(res, 400, '授权会话已失效', '请回到控制台重新发起授权。', '#e5677a');
      return;
    }
    if (error) {
      session.status = 'error';
      session.error = `TRAE 返回错误：${escapeHtml(error)}`;
      htmlResponse(res, 400, '授权未完成', escapeHtml(session.error), '#e5677a');
      return;
    }
    if (!code && !token) {
      session.status = 'error';
      session.error = '回调没有携带授权码';
      htmlResponse(res, 400, '授权未完成', '回调没有携带授权码，请回到控制台重试。', '#e5677a');
      return;
    }

    session.status = 'exchanging';
    try {
      const tokens = await this.#exchange({ code, token, session });
      const profile = await this.#userinfo(tokens.accessToken);
      session.status = 'success';
      session.credential = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || '',
        expiresAt: tokens.expiresAt || 0,
        machineId: session.machineId,
        deviceId: session.deviceId,
        userId: profile?.userId || '',
        email: profile?.email || '',
        name: profile?.name || ''
      };
      session.account = {
        label: profile?.name || profile?.email || 'TRAE',
        username: profile?.email || profile?.userId || ''
      };
      htmlResponse(res, 200, '授权成功', 'Token 已写入 Buddy2API，可以关闭本页。', '#64d6a4');
      log('[trae] authorization completed');
    } catch (error) {
      session.status = 'error';
      session.error = error.message;
      warn(`[trae] authorization failed: ${error.message}`);
      htmlResponse(res, 502, '换取 Token 失败', escapeHtml(error.message), '#e5677a');
    }
  }

  async #exchange({ code, token, session }) {
    if (token) {
      // Some TRAE builds hand the token back directly on the callback.
      return { accessToken: token, refreshToken: '', expiresAt: 0 };
    }

    const res = await fetch(`${OAUTH_HOST}${EXCHANGE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'TRAE/1.0'
      },
      body: JSON.stringify({
        authCode: code,
        code: code,
        codeVerifier: session.verifier,
        code_verifier: session.verifier,
        machineId: session.machineId,
        deviceId: session.deviceId
      }),
      signal: AbortSignal.timeout(30000)
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail =
        payload?.ResponseMetadata?.Error?.Message || payload?.message || payload?.error || '';
      throw authError(`TRAE token 交换失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`);
    }

    const data = payload.data || payload.result || payload;
    const accessToken = String(
      data.accessToken || data.access_token || data.Token || data.token || ''
    );
    if (!accessToken) throw authError('TRAE 交换响应缺少访问令牌');

    return {
      accessToken,
      refreshToken: String(data.refreshToken || data.refresh_token || ''),
      expiresAt: readTimestamp(data.expiresAt || data.expires_at || data.expireTime)
    };
  }

  async #userinfo(accessToken) {
    try {
      const res = await fetch(`${OAUTH_HOST}${USER_INFO_PATH}`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) return null;
      const payload = await res.json();
      const data = payload.data || payload.result || payload;
      return {
        userId: String(data.userId || data.user_id || data.uid || ''),
        email: String(data.email || ''),
        name: String(data.name || data.userName || data.nickname || '')
      };
    } catch {
      return null;
    }
  }

  poll(state) {
    return this.takeResult(state);
  }
}

function readTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export {
  AGENT_HOST as TRAE_AGENT_HOST,
  CHAT_PATH as TRAE_CHAT_PATH,
  MODELS_PATH as TRAE_MODELS_PATH,
  OAUTH_HOST as TRAE_OAUTH_HOST
};
