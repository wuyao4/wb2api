import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { log, warn } from '../../core/logger.js';
import { LoopbackListener, OAuthProvider, authError, escapeHtml, htmlResponse } from './base.js';

/**
 * Google (Gemini Code Assist) — OAuth authorization code + PKCE.
 *
 * Standard Google OAuth with a loopback redirect, which Google explicitly
 * supports for installed apps. The client id below is the one the Gemini CLI
 * ships with; it is a public client, so the PKCE verifier — not a secret — is
 * what protects the exchange.
 *
 * Verified live: the authorization URL with this client id and a loopback
 * redirect reaches Google's consent screen (no `invalid_client`).
 *
 * The resulting token is a Google access token for the Cloud Code Assist API,
 * not a generativelanguage API key; that is why this channel has its own
 * runtime instead of reusing the OpenAI-compatible one.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';

const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

export const GEMINI_CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com';
export const GEMINI_LOAD_CODE_ASSIST_PATH = '/v1internal:loadCodeAssist';
export const GEMINI_STREAM_PATH = '/v1internal:streamGenerateContent';
export const GEMINI_MODELS_PATH = '/v1internal:fetchAvailableModels';

function makePkce() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export class GeminiCodeAssistOAuth extends OAuthProvider {
  constructor({ persist }) {
    super({ id: 'gemini-code-assist', name: 'Gemini Code Assist', kind: 'loopback', persist });
    this.listener = new LoopbackListener({ path: '/oauth2callback', name: 'gemini' });
  }

  async start({ channelId = 'gemini-code-assist' } = {}) {
    this.prune();

    const pkce = makePkce();
    const state = randomUUID().replace(/-/g, '');

    const redirectUri = await this.listener.ensure((url, res) => {
      this.#handleCallback(url, res);
    });

    const session = {
      at: Date.now(),
      status: 'pending',
      channelId,
      verifier: pkce.verifier,
      redirectUri,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      controller: new AbortController()
    };
    this.sessions.set(state, session);

    const authUrl = `${AUTH_URL}?${new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      state
    }).toString()}`;

    return {
      state,
      authUrl,
      redirectUri,
      mode: 'loopback',
      channelId,
      expiresAt: session.expiresAt,
      note: '在浏览器登录 Google 账号并同意授权；本页会自动继续。'
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
      session.error = error === 'access_denied' ? '你拒绝了授权' : `Google 返回错误：${escapeHtml(error)}`;
      htmlResponse(res, 400, '授权未完成', escapeHtml(session.error), '#e5677a');
      return;
    }
    if (!code) {
      session.status = 'error';
      session.error = '没有拿到授权码';
      htmlResponse(res, 400, '授权未完成', '没有拿到授权码，请回到控制台重试。', '#e5677a');
      return;
    }

    session.status = 'exchanging';
    try {
      const tokens = await this.#exchange(code, session);
      const profile = await this.#userinfo(tokens.access_token);
      session.status = 'success';
      session.credential = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
        scope: tokens.scope || '',
        tokenType: tokens.token_type || 'Bearer',
        email: profile?.email || '',
        name: profile?.name || ''
      };
      session.account = {
        label: profile?.email || profile?.name || 'Gemini',
        username: profile?.email || ''
      };
      htmlResponse(res, 200, '授权成功', 'Token 已写入 Buddy2API，可以关闭本页。', '#64d6a4');
      log('[gemini] authorization completed');
    } catch (error) {
      session.status = 'error';
      session.error = error.message;
      warn(`[gemini] authorization failed: ${error.message}`);
      htmlResponse(res, 502, '换取 Token 失败', escapeHtml(error.message), '#e5677a');
    }
  }

  async #exchange(code, session) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        code,
        code_verifier: session.verifier,
        grant_type: 'authorization_code',
        redirect_uri: session.redirectUri
      }).toString(),
      signal: AbortSignal.timeout(30000)
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.access_token) {
      throw authError(
        `Google token 交换失败（HTTP ${res.status}）${payload.error_description ? `：${payload.error_description}` : ''}`
      );
    }
    return payload;
  }

  async #userinfo(accessToken) {
    try {
      const res = await fetch(USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  poll(state) {
    return this.takeResult(state);
  }

  /** Refresh using Google's refresh_token grant. */
  async refresh(credential) {
    if (!credential?.refreshToken) throw authError('该账号没有刷新令牌', 400);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        refresh_token: credential.refreshToken,
        grant_type: 'refresh_token'
      }).toString(),
      signal: AbortSignal.timeout(30000)
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.access_token) {
      throw authError(
        `Google token 续期失败（HTTP ${res.status}）${payload.error_description ? `：${payload.error_description}` : ''}`
      );
    }
    return {
      ...credential,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || credential.refreshToken,
      expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000
    };
  }
}
