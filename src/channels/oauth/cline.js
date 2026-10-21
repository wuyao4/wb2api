import { randomUUID } from 'node:crypto';
import { HttpError } from '../../core/errors.js';
import { log, warn } from '../../core/logger.js';
import { OAuthProvider, PollScheduler, authError } from './base.js';

/**
 * Cline — WorkOS device-code flow.
 *
 * The official desktop client uses this exact branch in production, and it is
 * the cleanest of the five: no callback port, no PKCE exchange, no browser
 * automation. Three steps:
 *
 *   1. POST {workos}/user_management/authorize/device   → device_code + user_code
 *   2. poll  {workos}/user_management/authenticate      → access_token (when approved)
 *   3. POST {api}/api/v1/auth/register                  → Cline's own token
 *
 * Verified live: step 1 returns a real device code, and step 2 answers
 * `authorization_pending` (HTTP 400) until the user approves.
 *
 * Two details that are easy to get wrong and are handled here:
 *   - `authorization_pending` is NOT a failure. It arrives with a 4xx status,
 *     so classifying by status code would abort a login that is simply waiting.
 *   - `slow_down` must actually back off; polling at a fixed rate after the
 *     server asks for slower traffic gets throttled further.
 */

const WORKOS_BASE = 'https://api.workos.com';
const API_BASE = 'https://api.cline.bot';
const CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR';

const DEVICE_PATH = '/user_management/authorize/device';
const AUTHENTICATE_PATH = '/user_management/authenticate';
const REGISTER_PATH = '/api/v1/auth/register';
const MODELS_PATH = '/api/v1/models';
const RECOMMENDED_PATH = '/api/v1/ai/cline/recommended-models';
const CHAT_PATH = '/api/v1/chat/completions';
const ME_PATH = '/api/v1/users/me';

const CLIENT_HEADERS = {
  'HTTP-Referer': 'https://cline.bot',
  'X-Title': 'Cline',
  'X-IS-MULTIROOT': 'false',
  'X-CLIENT-TYPE': 'cline-sdk'
};

/** The access token is stored with this prefix; stripping it causes a 401. */
export const CLINE_TOKEN_PREFIX = 'workos:';

/** Free models come only from the recommended-models feed, not /api/v1/models. */
export const CLINE_FALLBACK_MODELS = [
  { id: 'stealth/space-bunny-alpha', name: 'Space Bunny Alpha', context: 1000000, free: true },
  { id: 'cline-free/mimo-v2.6-flash', name: 'MiMo-V2.6-Flash', context: 1048576, free: true },
  {
    id: 'cline-free/muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3 Contributor',
    context: 1048576,
    free: true
  }
];

function normalizeToken(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  return value.startsWith(CLINE_TOKEN_PREFIX) ? value : `${CLINE_TOKEN_PREFIX}${value}`;
}

export class ClineOAuth extends OAuthProvider {
  constructor({ persist }) {
    super({ id: 'cline', name: 'Cline', kind: 'device-code', persist });
  }

  async start({ channelId = 'cline', label = 'Buddy2API' } = {}) {
    this.prune();

    const body = new URLSearchParams({ client_id: CLIENT_ID }).toString();
    let payload;
    try {
      const res = await fetch(`${WORKOS_BASE}${DEVICE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(30000)
      });
      payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw authError(
          `Cline 设备码申请失败（HTTP ${res.status}）${payload?.error_description ? `：${payload.error_description}` : ''}`
        );
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw authError(`无法连接 Cline 登录服务：${error.message}`);
    }

    const deviceCode = String(payload.device_code || '');
    const userCode = String(payload.user_code || '');
    const verificationUri = String(payload.verification_uri || '');
    const verificationUriComplete = String(payload.verification_uri_complete || '');
    if (!deviceCode || !userCode || !verificationUri) {
      throw authError('Cline 设备码响应缺少必要字段');
    }

    const state = randomUUID().replace(/-/g, '');
    const expiresInMs = Math.max(60000, Number(payload.expires_in || 300) * 1000);
    const session = {
      at: Date.now(),
      status: 'pending',
      channelId,
      label,
      userCode,
      verificationUri,
      verificationUriComplete: verificationUriComplete || verificationUri,
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      deviceCode,
      controller: new AbortController()
    };
    this.sessions.set(state, session);

    // Poll in the background: the dashboard polls our status endpoint, so the
    // approval is picked up even if the browser tab is closed.
    this.#pollInBackground(state, session, payload, expiresInMs);

    return {
      state,
      authUrl: verificationUriComplete || verificationUri,
      userCode,
      verificationUri,
      expiresAt: session.expiresAt,
      mode: 'device-code',
      channelId
    };
  }

  async #pollInBackground(state, session, authorization, expiresInMs) {
    const scheduler = new PollScheduler(Number(authorization.interval || 5) * 1000, {
      minMs: 1000,
      stepMs: 1000,
      maxMs: 30000
    });
    const deadline = Date.now() + expiresInMs;
    let failures = 0;

    try {
      while (Date.now() < deadline) {
        await scheduler.sleep(session.controller.signal);

        let res;
        let payload;
        try {
          res = await fetch(`${WORKOS_BASE}${AUTHENTICATE_PATH}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
              device_code: session.deviceCode,
              client_id: CLIENT_ID
            }).toString(),
            signal: session.controller.signal
          });
          payload = await res.json().catch(() => ({}));
          failures = 0;
        } catch (error) {
          if (session.controller.signal.aborted) return;
          failures += 1;
          if (failures >= 5) {
            throw authError(`无法连接 Cline 登录服务（连续 ${failures} 次失败）：${error.message}`);
          }
          continue;
        }

        if (res.ok) {
          const accessToken = String(payload.access_token || '');
          const refreshToken = String(payload.refresh_token || '');
          if (!accessToken) throw authError('Cline 授权响应缺少访问令牌');
          await this.#register(state, session, { accessToken, refreshToken });
          return;
        }

        const code = String(payload.error || '');
        if (code === 'authorization_pending') continue;
        if (code === 'slow_down') {
          scheduler.slowDown();
          continue;
        }
        if (code === 'access_denied' || code === 'expired_token' || code === 'invalid_grant') {
          throw authError(`Cline 授权失败：${payload.error_description || code}`);
        }
        throw authError(
          `Cline 授权轮询失败（HTTP ${res.status}）${payload.error_description ? `：${payload.error_description}` : ''}`
        );
      }
      throw authError('Cline 授权超时，请重新发起');
    } catch (error) {
      if (session.status === 'success') return;
      // A deliberate close() aborts the signal; that is not an auth failure.
      if (session.controller.signal.aborted) return;
      session.status = 'error';
      session.error = error.message;
      warn(`[cline] authorization failed: ${error.message}`);
    }
  }

  async #register(state, session, tokens) {
    const res = await fetch(`${API_BASE}${REGISTER_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CLIENT_HEADERS },
      body: JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken
      }),
      signal: session.controller.signal
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw authError(
        `Cline token 注册失败（HTTP ${res.status}）${payload?.error ? `：${payload.error}` : ''}`
      );
    }

    const data = payload.data || payload;
    const accessToken = normalizeToken(data.accessToken || data.access_token);
    const refreshToken = String(data.refreshToken || data.refresh_token || tokens.refreshToken || '');
    if (!accessToken) throw authError('Cline 注册响应缺少访问令牌');

    const userInfo = data.userInfo || data.user_info || {};
    const expiresAt = Number(data.expiresAt || data.expires_at || 0);

    session.status = 'success';
    session.credential = {
      accessToken,
      refreshToken,
      expiresAt: expiresAt > 0 ? (expiresAt < 1e12 ? expiresAt * 1000 : expiresAt) : 0,
      userId: String(userInfo.clineUserId || userInfo.cline_user_id || userInfo.id || ''),
      email: String(userInfo.email || ''),
      displayName: String(userInfo.name || userInfo.displayName || '')
    };
    session.account = {
      label: session.credential.displayName || session.credential.email || 'Cline',
      username: session.credential.email || session.credential.userId
    };
    log('[cline] authorization completed');
  }

  poll(state) {
    return this.takeResult(state);
  }
}

/** Read the Cline credential shape used by the channel runtime. */
export function clineRequestHeaders(accessToken) {
  return {
    ...CLIENT_HEADERS,
    Authorization: `Bearer ${normalizeToken(accessToken)}`
  };
}

export { API_BASE as CLINE_API_BASE, CHAT_PATH as CLINE_CHAT_PATH, MODELS_PATH as CLINE_MODELS_PATH, RECOMMENDED_PATH as CLINE_RECOMMENDED_PATH, ME_PATH as CLINE_ME_PATH };
