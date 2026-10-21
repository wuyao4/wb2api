import { createHash, createHmac, randomUUID } from 'node:crypto';
import { log, warn } from '../../core/logger.js';
import { HttpError } from '../../core/errors.js';
import { OAuthProvider, SESSION_TTL_MS, authError } from './base.js';

/**
 * Loomy (讯飞) — SMS code login.
 *
 * This is the one channel with no URL to open: the account service authenticates
 * with a phone number plus an SMS code, so the dashboard renders a form instead
 * of a button. The provider contract is still the same (start → poll), which is
 * why it lives here rather than in a separate subsystem.
 *
 * Verified live: `POST /login/phone/sendMsgCode` answers
 * `401 {"message":"HMAC signature cannot be verified"}` for an unsigned request,
 * confirming both the endpoint and that signing is mandatory.
 *
 * Signing is the fragile part, and it is handled exactly as the client does:
 * the body is serialized **once** and that same string is both signed and sent.
 * Serializing twice (or letting the HTTP layer re-serialize) changes the bytes
 * and the signature fails.
 */

const ACCOUNT_BASE = 'https://account.xfinfr.com';
const API_BASE = 'https://loomyad.xunfei.cn/api/v1';

const SEND_PATH = '/login/phone/sendMsgCode';
const CHECK_PATH = '/login/phone/checkCode';

/**
 * Public client constants shipped inside the official desktop bundle.
 *
 * ⚠️ These are NOT user credentials and give no access to anyone's account:
 * they only sign the *login request* to the SMS endpoint. Inference uses the
 * `session` returned after the user verifies their own code. The values are
 * already distributed with the vendor's client (and in the reference project),
 * so they are not a secret boundary — but they should not be treated as a
 * place to add real secrets either.
 */
const ACCESS_KEY_ID = '2thryby66wxi53sk';
const ACCESS_KEY_SECRET = 'zsak6eadrbawz683wf5r3m2snrwj868r';
const APP_ID = 'GM3LOOMY';

const SMS_TTL_SECONDS = 300;
const SESSION_TTL_SECONDS = 1209600; // 14 days, as the client declares

export const LOOMY_FALLBACK_MODELS = [
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731' },
  { id: 'MiniMax-M3', name: 'MiniMax M3' },
  { id: 'Kimi-k2.6', name: 'Kimi k2.6' },
  { id: 'qwen-3.8-max', name: 'Qwen 3.8 Max' },
  { id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash' },
  { id: 'spark-x', name: 'Spark X2.5' }
];

/**
 * RFC 3986 escaping (encodeURIComponent plus the four characters it leaves).
 * Used for both path segments and query values, exactly as the client does.
 */
function escapeRfc3986(value) {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function escapedPath(rawPath) {
  let clean = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1);
  return clean
    .split('/')
    .map((segment) => (segment.length > 0 ? escapeRfc3986(segment) : ''))
    .join('/');
}

/**
 * Content-MD5 (base64). An empty body yields an empty string, not the MD5 of
 * the empty string — the client does the same.
 */
function contentMd5(body) {
  if (!body) return '';
  return createHash('md5').update(body, 'utf8').digest('base64');
}

/**
 * Build the `Authorization: account {ak}:{sig}` header set.
 *
 * The string to sign is **nine** newline-joined fields:
 *
 *   METHOD \n ESCAPED_PATH \n ESCAPED_QUERY \n CONTENT_MD5 \n
 *   CONTENT_TYPE \n DATE \n NONCE \n SIGNED_HEADERS \n CANONICALIZED_HEADERS
 *
 * The last two are always empty here (we send no `x-*` headers), so the string
 * ends with two newlines. Dropping that trailing blank line breaks the
 * signature — it is a natural consequence of joining nine fields, not a typo.
 *
 * `Date` must be the UTC string and `Nonce` a UUID; both are also sent as
 * headers, because the server recomputes the same string from them.
 */
function signedHeaders(path, serializedBody, contentType = 'application/json') {
  const date = new Date().toUTCString();
  const nonce = randomUUID();
  const md5 = contentMd5(serializedBody);

  const stringToSign = [
    'POST',
    escapedPath(path),
    '', // escaped query: these endpoints take no query parameters
    md5,
    contentType,
    date,
    nonce,
    '', // signed headers
    '' // canonicalized headers
  ].join('\n');

  const signature = createHmac('sha1', ACCESS_KEY_SECRET).update(stringToSign, 'utf8').digest('base64');

  const headers = {
    Authorization: `account ${ACCESS_KEY_ID}:${signature}`,
    Date: date,
    Nonce: nonce,
    'Content-Type': contentType,
    Accept: 'application/json',
    'User-Agent': 'Loomy/1.0 (Desktop)'
  };
  if (md5) headers['Content-MD5'] = md5;
  return headers;
}

/** The `{ base, param }` envelope every account endpoint expects. */
function accountBody(param) {
  return {
    base: {
      appid: APP_ID,
      modelid: 'Web',
      version: '1.0.0',
      devid: 'web',
      // Hardcoded macOS in the client, including on Windows. Copied verbatim.
      ua: 'Loomy|Desktop|Electron|macOS',
      traceid: randomUUID().replace(/-/g, '')
    },
    param
  };
}

/** Unwrap the `{ code, data, message }` envelope; throw on a business error. */
function unwrap(payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object') throw authError(fallbackMessage);
  const code = String(payload.code ?? payload.retcode ?? '');
  // `000000` is success; anything else carries a human-readable description.
  if (code && code !== '000000') {
    const message =
      payload.message || payload.desc || payload.msg || `${fallbackMessage}（code ${code}）`;
    throw authError(String(message));
  }
  return payload.data ?? payload.result ?? payload;
}

async function postAccount(path, param, { signal } = {}) {
  const serialized = JSON.stringify(accountBody(param));
  const res = await fetch(`${ACCOUNT_BASE}${path}`, {
    method: 'POST',
    headers: signedHeaders(path, serialized),
    body: serialized,
    signal: signal || AbortSignal.timeout(60000)
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    throw authError(`Loomy 响应不是 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const message = payload?.message || payload?.desc || `HTTP ${res.status}`;
    throw authError(`Loomy 请求失败：${message}`);
  }
  return unwrap(payload, 'Loomy 请求失败');
}

export class LoomyOAuth extends OAuthProvider {
  constructor({ persist }) {
    super({ id: 'loomy', name: 'Loomy', kind: 'sms', persist });
  }

  /**
   * Step 1: send the SMS code.
   *
   * Returns the `msgid` the verify step must echo back. Sessions are keyed by
   * state so a concurrent login cannot be mixed up with another phone number.
   */
  async start({ channelId = 'loomy', phone = '' } = {}) {
    this.prune();

    const number = String(phone || '').replace(/\D/g, '');
    if (number.length < 6) throw authError('请填写手机号', 400);

    const data = await postAccount(SEND_PATH, {
      ccode: '86',
      phone: number,
      expire: SMS_TTL_SECONDS
    });

    const msgid = String(data?.msgid || '');
    if (!msgid) {
      // Never continue with an empty msgid: the verify step would fail with a
      // message unrelated to the real cause.
      throw authError('短信验证码响应缺少 msgid');
    }

    const state = randomUUID().replace(/-/g, '');
    this.sessions.set(state, {
      at: Date.now(),
      status: 'pending',
      channelId,
      phone: number,
      msgid,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    });

    return {
      state,
      mode: 'sms',
      channelId,
      phone: number,
      expiresAt: new Date(Date.now() + SMS_TTL_SECONDS * 1000).toISOString(),
      note: '验证码已发送，请填写收到的 6 位验证码。'
    };
  }

  /** Step 2: submit the code. The result is picked up through `poll`. */
  async submitCode(state, code) {
    this.prune();

    const session = this.sessions.get(state);
    if (!session) throw new HttpError(404, '登录会话不存在或已过期，请重新获取验证码');
    if (session.status === 'success') return { status: 'success' };

    const value = String(code || '').replace(/\D/g, '');
    if (value.length < 4) throw authError('请填写正确的验证码', 400);

    session.status = 'exchanging';
    try {
      const data = await postAccount(CHECK_PATH, {
        ccode: '86',
        phone: session.phone,
        mcode: value,
        msgid: session.msgid,
        expire: SESSION_TTL_SECONDS
      });

      const sessionToken = String(data?.session || '');
      const userid = String(data?.userid || '');
      if (!sessionToken) throw authError('登录响应缺少 session');
      if (!userid) throw authError('登录响应缺少 userid');

      session.status = 'success';
      session.credential = {
        accessToken: sessionToken,
        userId: userid,
        // The response carries no expiry; the client declares 14 days.
        expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
        phone: session.phone
      };
      session.account = {
        label: maskPhone(session.phone),
        username: maskPhone(session.phone)
      };
      log('[loomy] SMS login completed');
      return { status: 'success' };
    } catch (error) {
      session.status = 'pending';
      warn(`[loomy] code verification failed: ${error.message}`);
      throw error;
    }
  }

  poll(state) {
    return this.takeResult(state);
  }
}

function maskPhone(phone) {
  const value = String(phone || '');
  if (value.length < 7) return value;
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

export { API_BASE as LOOMY_API_BASE, ACCOUNT_BASE as LOOMY_ACCOUNT_BASE };
