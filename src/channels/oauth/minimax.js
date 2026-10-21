import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { log, warn } from '../../core/logger.js';
import { OAuthProvider, PollScheduler, authError } from './base.js';

/**
 * MiniMax Code — device code + PKCE.
 *
 * The official desktop client uses exactly this branch, so nothing has to be
 * guessed and no local port is opened:
 *
 *   1. POST {account}/oauth2/device/code  → device_code + user_code
 *   2. the user approves at verification_uri
 *   3. POST {account}/oauth2/token        → access_token
 *
 * Verified live: step 1 answers 200 with a real `user_code` (e.g. `FGYP-439U`)
 * and `verification_uri_complete`.
 *
 * The one trap that breaks a standard implementation: **`pending` arrives as
 * HTTP 200 with `status: "pending"`**, not as 400 + `error=authorization_pending`.
 * Accepting only the standard shape aborts the login before the user can approve.
 * Both shapes are handled here.
 *
 * Credentials are validated strictly by the provider: the token response must
 * carry `token_type: Bearer`, a positive `expires_in`, and a `scope` containing
 * `agent.default`. A response missing any of those is not a usable credential.
 */

const ACCOUNT_HOST = 'https://account.minimax.cn';
const DEVICE_PATH = '/oauth2/device/code';
const TOKEN_PATH = '/oauth2/token';
const CLIENT_ID = 'mcode-public';
const AUDIENCE = 'agent-backend';
const SCOPE = 'agent.default';

export const MINIMAX_FALLBACK_MODELS = [
  { id: 'MiniMax-M3', name: 'MiniMax M3' },
  { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
  { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' }
];

function makePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

/** Strict token-response validation (mirrors what the client requires). */
function parseTokenGrant(payload, previousRefreshToken = '') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw authError('MiniMax 令牌响应不是对象');
  }

  const accessToken = String(payload.access_token || '').trim();
  const refreshToken = String(payload.refresh_token || '').trim() || previousRefreshToken;
  const tokenType = String(payload.token_type || '').trim();
  const expiresInSec = Number(payload.expires_in);
  const scope = String(payload.scope || '');

  if (!accessToken) throw authError('MiniMax 令牌响应缺少 access_token');
  if (!refreshToken) throw authError('MiniMax 令牌响应缺少 refresh_token');
  if (tokenType.toLowerCase() !== 'bearer') {
    throw authError('MiniMax 令牌响应的 token_type 不是 Bearer');
  }
  if (!Number.isFinite(expiresInSec) || expiresInSec <= 0) {
    throw authError('MiniMax 令牌响应缺少 expires_in');
  }
  // The provider rejects credentials whose scope lost `agent.default`.
  if (!scope.split(/\s+/).filter(Boolean).includes(SCOPE)) {
    throw authError(`MiniMax 令牌响应的 scope 不含 ${SCOPE}`);
  }

  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    scope,
    // `expires_in` is authoritative: the access token is not a JWT
    // (`mmoat_` prefix, no dots), so its expiry cannot be decoded from it.
    expiresAt: Date.now() + expiresInSec * 1000
  };
}

export class MinimaxOAuth extends OAuthProvider {
  constructor({ persist }) {
    super({ id: 'minimax-code', name: 'MiniMax Code', kind: 'device-code', persist });
  }

  async start({ channelId = 'minimax-code' } = {}) {
    this.prune();

    const pkce = makePkce();
    let payload;
    try {
      const res = await fetch(`${ACCOUNT_HOST}${DEVICE_PATH}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          scope: SCOPE,
          audience: AUDIENCE,
          code_challenge: pkce.challenge,
          code_challenge_method: 'S256'
        }).toString(),
        signal: AbortSignal.timeout(30000)
      });
      payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw authError(
          `MiniMax 设备码申请失败（HTTP ${res.status}）${payload?.error_description ? `：${payload.error_description}` : ''}`
        );
      }
    } catch (error) {
      if (error.status) throw error;
      throw authError(`无法连接 MiniMax 登录服务：${error.message}`);
    }

    const deviceCode = String(payload?.device_code || '');
    const userCode = String(payload?.user_code || '');
    const verificationUri = String(payload?.verification_uri || payload?.verification_url || '');
    const expiresInSec = Number(payload?.expires_in);
    if (!deviceCode || !userCode || !verificationUri || !Number.isFinite(expiresInSec)) {
      throw authError('MiniMax 设备码响应缺少必要字段');
    }

    const state = randomUUID().replace(/-/g, '');
    const intervalSec = Number(payload?.interval) > 0 ? Number(payload.interval) : 5;
    const session = {
      at: Date.now(),
      status: 'pending',
      channelId,
      deviceCode,
      verifier: pkce.verifier,
      userCode,
      verificationUri,
      verificationUriComplete: String(payload?.verification_uri_complete || verificationUri),
      expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      controller: new AbortController()
    };
    this.sessions.set(state, session);
    this.#pollInBackground(state, session, intervalSec, expiresInSec);

    return {
      state,
      authUrl: session.verificationUriComplete,
      userCode,
      verificationUri,
      mode: 'device-code',
      channelId,
      expiresAt: session.expiresAt,
      note: '在浏览器完成 MiniMax 授权；确认设备码一致后继续。'
    };
  }

  async #pollInBackground(state, session, intervalSec, expiresInSec) {
    const scheduler = new PollScheduler(intervalSec * 1000, {
      minMs: 1000,
      stepMs: 1000,
      maxMs: 30000
    });
    const deadline = Date.now() + expiresInSec * 1000;
    let failures = 0;

    try {
      while (Date.now() < deadline) {
        await scheduler.sleep(session.controller.signal);

        let payload = null;
        let status = 0;
        try {
          const res = await fetch(`${ACCOUNT_HOST}${TOKEN_PATH}`, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
              device_code: session.deviceCode,
              client_id: CLIENT_ID,
              code_verifier: session.verifier
            }).toString(),
            signal: session.controller.signal
          });
          status = res.status;
          payload = await res.json().catch(() => null);
          failures = 0;
        } catch (error) {
          if (session.controller.signal.aborted) return;
          failures += 1;
          if (failures >= 5) {
            throw authError(`无法连接 MiniMax 登录服务（连续 ${failures} 次失败）：${error.message}`);
          }
          continue;
        }

        // Non-standard shape: 200 + status=pending.
        const phase = String(payload?.status || '');
        if (phase === 'pending' || phase === 'authorization_pending') continue;
        if (phase === 'denied' || phase === 'access_denied') throw authError('MiniMax 授权被拒绝');
        if (phase === 'expired' || phase === 'expired_token') {
          throw authError('MiniMax 设备码已过期，请重新发起');
        }

        // Standard shape: 400 + error=authorization_pending.
        const errorCode = String(payload?.error || '');
        if (errorCode === 'authorization_pending') continue;
        if (errorCode === 'slow_down') {
          scheduler.slowDown();
          continue;
        }
        if (errorCode === 'access_denied') throw authError('MiniMax 授权被拒绝');
        if (errorCode === 'expired_token') throw authError('MiniMax 设备码已过期，请重新发起');

        if (status === 200 && payload?.access_token) {
          const credential = parseTokenGrant(payload);
          session.status = 'success';
          session.credential = credential;
          session.account = {
            label: 'MiniMax Code',
            username: credential.scope
          };
          log('[minimax] authorization completed');
          return;
        }

        if (status >= 400) {
          throw authError(
            `MiniMax 授权轮询失败（HTTP ${status}）${payload?.error_description ? `：${payload.error_description}` : ''}`
          );
        }
      }
      throw authError('MiniMax 授权超时，请重新发起');
    } catch (error) {
      if (session.status === 'success') return;
      if (session.controller.signal.aborted) return;
      session.status = 'error';
      session.error = error.message;
      warn(`[minimax] authorization failed: ${error.message}`);
    }
  }

  poll(state) {
    return this.takeResult(state);
  }

  /** Refresh with the stored refresh_token. */
  async refresh(credential) {
    if (!credential?.refreshToken) throw authError('该账号没有刷新令牌', 400);
    const res = await fetch(`${ACCOUNT_HOST}${TOKEN_PATH}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
        client_id: CLIENT_ID,
        scope: SCOPE,
        audience: AUDIENCE
      }).toString(),
      signal: AbortSignal.timeout(30000)
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      throw authError(
        `MiniMax 续期失败（HTTP ${res.status}）${payload?.error_description ? `：${payload.error_description}` : ''}`
      );
    }
    return { ...credential, ...parseTokenGrant(payload, credential.refreshToken) };
  }
}

export { ACCOUNT_HOST as MINIMAX_ACCOUNT_HOST };
