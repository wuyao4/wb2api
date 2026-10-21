import { randomBytes, randomUUID } from 'node:crypto';
import { log, warn } from '../../core/logger.js';
import { qrSvg } from '../../core/qr.js';
import { OAuthProvider, PollScheduler, authError } from './base.js';

/**
 * Raccoon (SenseTime) — QR-code login, hosted locally.
 *
 * Raccoon is NOT an OAuth provider: its desktop client returns through the
 * custom scheme `office-raccoon://auth/callback`, which a Node process cannot
 * receive, and `/code/authorize` hardcodes that callback — pointing it at
 * localhost yields "授权链接无效" (verified in a real browser).
 *
 * The workable flow is the web/QR one, and it does not need a redirect at all:
 *
 *   1. the host generates a 32-hex `qrcode_code` itself
 *   2. the user scans a QR that carries that code inside WeChat
 *   3. the host polls `login_with_qrcode_code` until it returns a token
 *
 * Verified live: the poll endpoint answers
 * `{"code":0,"data":{"status":"pending"}}` for a self-generated code, which is
 * exactly the "waiting for the scan" state. WeChat performs the login; we never
 * see the user's credentials and never emulate the client's custom-scheme
 * callback.
 *
 * The QR image is rendered locally as SVG (no CDN, no third-party service), and
 * the code stays on the host.
 */

const API_BASE = 'https://xiaohuanxiong.com';
const AUTH_PREFIX = '/api/web/auth/v1';
const LLM_PREFIX = '/api/web/llm/v2';

const QR_POLL_PATH = '/api/web/auth/v1/login_with_qrcode_code';
const QR_LANDING_PATH = '/login/mp';
const USERINFO_PATH = '/api/web/auth/v1/user/info';
const MODELS_PATH = '/api/web/llm/v2/models';
const CHAT_PATH = '/api/web/llm/v2/chat/completions';

const CLIENT_PLATFORM = 'desktop-windows';
const CLIENT_VERSION = 'v1.0.35';

export const RACCOON_FALLBACK_MODELS = [
  { id: 'raccoon-auto', name: 'Raccoon Auto' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' }
];

/** Generate the scan code ourselves; the server accepts any 32-hex value. */
function makeQrCode() {
  return randomBytes(16).toString('hex');
}

export class RaccoonOAuth extends OAuthProvider {
  constructor({ persist }) {
    super({ id: 'raccoon', name: 'Raccoon', kind: 'qr', persist });
  }

  async start({ channelId = 'raccoon' } = {}) {
    this.prune();

    const qrCode = makeQrCode();
    const state = randomUUID().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const session = {
      at: Date.now(),
      status: 'pending',
      channelId,
      qrCode,
      expiresAt,
      controller: new AbortController()
    };
    this.sessions.set(state, session);
    this.#pollInBackground(state, session);

    return {
      state,
      // There is no external auth page: the dashboard renders the QR itself.
      authUrl: '',
      mode: 'qr',
      channelId,
      expiresAt,
      qrCode,
      qrPayload: `${API_BASE}${QR_LANDING_PATH}?code=${qrCode}&appname=${encodeURIComponent('商汤小浣熊官网')}`,
      note: '用微信扫描二维码完成登录；本页会自动继续。'
    };
  }

  async #pollInBackground(state, session) {
    const scheduler = new PollScheduler(2000, { minMs: 2000, stepMs: 1000, maxMs: 8000 });
    const deadline = Date.now() + 5 * 60 * 1000;
    let failures = 0;

    try {
      while (Date.now() < deadline) {
        await scheduler.sleep(session.controller.signal);

        let payload;
        try {
          const res = await fetch(`${API_BASE}${QR_POLL_PATH}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Client-Platform': CLIENT_PLATFORM,
              'X-Client-Version': CLIENT_VERSION
            },
            body: JSON.stringify({ qrcode_code: session.qrCode }),
            signal: session.controller.signal
          });
          payload = await res.json().catch(() => null);
          failures = 0;
        } catch (error) {
          if (session.controller.signal.aborted) return;
          failures += 1;
          // A flaky poll must not abort a login the user is completing.
          if (failures >= 10) {
            throw authError(`无法连接 Raccoon 登录服务（连续 ${failures} 次失败）：${error.message}`);
          }
          continue;
        }

        if (!payload || payload.code !== 0 || !payload.data) continue;

        const status = String(payload.data.status || '');
        if (status === 'canceled') throw authError('扫码登录已取消');
        if (status === 'expired') throw authError('二维码已过期，请重新发起');
        if (status !== 'success') continue;

        const accessToken = String(payload.data.access_token || '');
        if (!accessToken) continue; // a tokenless "success" is not a success

        session.status = 'success';
        session.credential = {
          accessToken,
          refreshToken: String(payload.data.refresh_token || ''),
          expiresAt: decodeJwtExpiry(accessToken),
          userId: String(payload.data.user_id || payload.data.uid || ''),
          name: String(payload.data.nickname || payload.data.user_name || '')
        };
        session.account = {
          label: session.credential.name || 'Raccoon',
          username: session.credential.name || session.credential.userId
        };
        log('[raccoon] QR login completed');
        return;
      }
      throw authError('Raccoon 扫码登录超时，请重新发起');
    } catch (error) {
      if (session.status === 'success') return;
      if (session.controller.signal.aborted) return;
      session.status = 'error';
      session.error = error.message;
      warn(`[raccoon] login failed: ${error.message}`);
    }
  }

  poll(state) {
    const result = this.takeResult(state);
    // While pending, keep handing the QR payload back so a refreshed dashboard
    // can redraw it without starting a new session.
    if (result.status === 'pending') {
      const session = this.sessions.get(state);
      if (session) {
        result.qrCode = session.qrCode;
        result.qrPayload = `${API_BASE}${QR_LANDING_PATH}?code=${session.qrCode}&appname=${encodeURIComponent('商汤小浣熊官网')}`;
        result.qrSvg = qrSvg(result.qrPayload, { size: 208 });
      }
    }
    return result;
  }
}

function decodeJwtExpiry(token) {
  try {
    const payload = String(token).split('.')[1];
    if (!payload) return 0;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(json.exp) ? Number(json.exp) * 1000 : 0;
  } catch {
    return 0;
  }
}

export {
  API_BASE as RACCOON_API_BASE,
  AUTH_PREFIX as RACCOON_AUTH_PREFIX,
  LLM_PREFIX as RACCOON_LLM_PREFIX,
  CHAT_PATH as RACCOON_CHAT_PATH,
  MODELS_PATH as RACCOON_MODELS_PATH,
  USERINFO_PATH as RACCOON_USERINFO_PATH
};
