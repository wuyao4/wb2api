import { randomBytes, randomUUID } from 'node:crypto';
import { log, warn } from '../../core/logger.js';
import { OAuthProvider, PollScheduler, authError } from './base.js';

/**
 * ZCode (智谱) — server-mediated device authorization.
 *
 * The desktop client's own flow depends on the `zcode://` custom scheme, which a
 * Node process cannot receive. ZCode 3.12.3+ ships a second branch that the
 * official CLI uses and that needs no local callback at all:
 *
 *   1. POST /api/v1/oauth/cli/init      → flow_id + authorize_url
 *      (Authorization is a *self-generated* session secret, not a user token)
 *   2. the user authorizes in the browser; the provider redirects to its own
 *      server-side callback, so nothing has to reach us
 *   3. GET  /api/v1/oauth/cli/poll/{flow_id} → { status: 'ready', token, ... }
 *
 * Verified live: step 1 answers 200 with a real `flow_id` and an
 * `authorize_url` pointing at bigmodel.cn. This deliberately avoids
 * `POST /api/v1/oauth/token`, which upstream has been failing (500 / code 2007).
 *
 * Two provider variants exist and differ only in where the third-party token
 * lands (`data.bigmodel` vs `data.zai`); both are handled.
 */

const ORIGIN = 'https://zcode.z.ai';
const INIT_PATH = '/api/v1/oauth/cli/init';
const POLL_PATH = '/api/v1/oauth/cli/poll';
const APP_VERSION = '3.14.3';

/** `bigmodel` = 智谱开放平台（国内）; `zai` = z.ai（国际版）. */
export const ZCODE_PROVIDERS = ['bigmodel', 'zai'];

export const ZCODE_FALLBACK_MODELS = [
  { id: 'GLM-5.3', name: 'GLM-5.3' },
  { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash' },
  { id: 'GLM-5.2', name: 'GLM-5.2' }
];

/** 32-byte hex session secret — the CLI's own `Bearer` value, not a user token. */
function makeFlowSecret() {
  return randomBytes(32).toString('hex');
}

function baseHeaders(secret) {
  return {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': `ZCode/${APP_VERSION}`,
    'HTTP-Referer': ORIGIN,
    'X-ZCode-App-Version': APP_VERSION,
    'X-Platform': 'win32'
  };
}

export class ZcodeOAuth extends OAuthProvider {
  constructor({ persist }) {
    super({ id: 'zcode', name: 'ZCode', kind: 'device-code', persist });
  }

  async start({ channelId = 'zcode', provider = 'bigmodel' } = {}) {
    this.prune();

    const variant = ZCODE_PROVIDERS.includes(provider) ? provider : 'bigmodel';
    const secret = makeFlowSecret();

    let payload;
    try {
      const res = await fetch(`${ORIGIN}${INIT_PATH}`, {
        method: 'POST',
        headers: baseHeaders(secret),
        body: JSON.stringify({ provider: variant }),
        signal: AbortSignal.timeout(30000)
      });
      const text = await res.text();
      try {
        payload = JSON.parse(text);
      } catch {
        throw authError(`ZCode 授权初始化响应不是 JSON：${text.slice(0, 160)}`);
      }
      if (!res.ok) {
        throw authError(
          `ZCode 授权初始化失败（HTTP ${res.status}）${payload?.msg ? `：${payload.msg}` : ''}`
        );
      }
    } catch (error) {
      if (error.status) throw error;
      throw authError(`无法连接 ZCode 授权服务：${error.message}`);
    }

    const data = payload?.data || {};
    const flowId = String(data.flow_id || '');
    const authorizeUrl = String(data.authorize_url || '');
    if (!flowId) throw authError(`ZCode 授权初始化缺少 flow_id${payload?.msg ? `：${payload.msg}` : ''}`);
    if (!authorizeUrl.startsWith('https://')) throw authError('ZCode 授权初始化缺少合法的 authorize_url');

    const state = randomUUID().replace(/-/g, '');
    const pollIntervalSec =
      Number.isFinite(Number(data.poll_interval_sec)) && Number(data.poll_interval_sec) >= 1
        ? Number(data.poll_interval_sec)
        : 2;
    const expiresAtSec = Number(data.expires_at) || 0;

    const session = {
      at: Date.now(),
      status: 'pending',
      channelId,
      flowId,
      variant,
      expiresAt: new Date(
        expiresAtSec > 0 ? expiresAtSec * 1000 : Date.now() + 10 * 60 * 1000
      ).toISOString(),
      controller: new AbortController()
    };
    this.sessions.set(state, session);
    this.#pollInBackground(state, session, pollIntervalSec);

    return {
      state,
      authUrl: authorizeUrl,
      mode: 'device-code',
      channelId,
      expiresAt: session.expiresAt,
      note: '在浏览器完成智谱账号授权；本页会自动继续。'
    };
  }

  async #pollInBackground(state, session, intervalSec) {
    const scheduler = new PollScheduler(intervalSec * 1000, {
      minMs: 1000,
      stepMs: 1000,
      maxMs: 15000
    });
    const deadline = Date.now() + 10 * 60 * 1000;
    let failures = 0;

    try {
      while (Date.now() < deadline) {
        await scheduler.sleep(session.controller.signal);

        let payload = null;
        let status = 0;
        try {
          const res = await fetch(
            `${ORIGIN}${POLL_PATH}/${encodeURIComponent(session.flowId)}`,
            {
              headers: {
                Accept: 'application/json',
                'User-Agent': `ZCode/${APP_VERSION}`,
                'X-ZCode-App-Version': APP_VERSION,
                'X-Platform': 'win32'
              },
              signal: session.controller.signal
            }
          );
          status = res.status;
          payload = await res.json().catch(() => null);
          failures = 0;
        } catch (error) {
          if (session.controller.signal.aborted) return;
          failures += 1;
          if (failures >= 5) {
            throw authError(`无法连接 ZCode 授权服务（连续 ${failures} 次失败）：${error.message}`);
          }
          continue;
        }

        const data = payload?.data || {};
        const phase = String(data.status || '');

        if (phase === 'pending' || phase === 'waiting') continue;
        if (phase === 'denied' || phase === 'cancelled') throw authError('ZCode 授权被拒绝');
        if (phase === 'expired') throw authError('ZCode 授权已过期，请重新发起');
        if (phase !== 'ready') {
          if (status >= 400 && phase === '') continue;
          continue;
        }

        const zcodeJwt = String(data.token || data.access_token || '');
        if (!zcodeJwt) throw authError('ZCode 授权响应缺少 token');

        // The third-party token lands under the variant name.
        const third = data[session.variant] || data.bigmodel || data.zai || {};
        const user = data.user || {};

        session.status = 'success';
        session.credential = {
          accessToken: zcodeJwt,
          // Kept separately: the bigmodel/zai token is what inference uses.
          providerToken: String(third.access_token || ''),
          refreshToken: String(third.refresh_token || ''),
          provider: session.variant,
          userId: String(user.id || user.user_id || ''),
          name: String(user.name || user.email || user.nickname || ''),
          // ZCode credentials are static JWTs (no exp) and cannot be refreshed.
          expiresAt: 0
        };
        session.account = {
          label: session.credential.name || 'ZCode',
          username: session.credential.name || session.credential.userId
        };
        log('[zcode] authorization completed');
        return;
      }
      throw authError('ZCode 授权超时，请重新发起');
    } catch (error) {
      if (session.status === 'success') return;
      if (session.controller.signal.aborted) return;
      session.status = 'error';
      session.error = error.message;
      warn(`[zcode] authorization failed: ${error.message}`);
    }
  }

  poll(state) {
    return this.takeResult(state);
  }
}

export { ORIGIN as ZCODE_ORIGIN };
