import { randomBytes } from 'node:crypto';

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

export function decodeJwt(token) {
  try {
    const payload = String(token).split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function isJwt(value) {
  return typeof value === 'string' && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

export function jwtExpiresAt(token) {
  const payload = decodeJwt(token);
  return Number(payload?.exp) || 0;
}

export function profileFromToken(token) {
  const payload = decodeJwt(token);
  if (!payload) return null;
  return {
    sub: payload.sub || '',
    username: payload.preferred_username || payload.username || '',
    email: payload.email || '',
    name: payload.name || '',
    type: payload.typ || '',
    expiresAt: Number(payload.exp) || 0
  };
}

export function generateApiKey() {
  return `sk-wb-${randomBytes(16).toString('hex')}`;
}

export function maskToken(token) {
  if (!token) return '';
  const text = String(token);
  if (text.length <= 20) return `${text.slice(0, 4)}...`;
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}

function stripBearer(value) {
  return String(value).replace(/^Bearer\s+/i, '').trim();
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const ACCESS_KEYS = new Set(['authorization', 'accesstoken', 'accesstokenvalue', 'bearer']);
const REFRESH_KEYS = new Set(['xrefreshtoken', 'refreshtoken', 'refreshtokenvalue']);
const DEVICE_KEYS = new Set(['xdevicetoken', 'devicetoken']);
const USER_KEYS = new Set(['xuserid', 'userid']);

/**
 * Accepts a bare JWT, `Header: value` lines, a JSON object of headers, or an
 * array such as [{ "name": "Authorization", "value": "Bearer ..." }].
 * Returns whatever credentials could be identified.
 */
export function extractCredentials(input) {
  const found = { accessToken: '', refreshToken: '', deviceToken: '', userId: '' };
  if (!input) return found;
  const text = String(input).trim();
  if (!text) return found;

  const setAccess = (value) => {
    const token = stripBearer(value);
    if (!isJwt(token)) return;
    const current = jwtExpiresAt(found.accessToken);
    if (!found.accessToken || jwtExpiresAt(token) > current) found.accessToken = token;
  };

  const setRefresh = (value) => {
    const token = stripBearer(value);
    if (isJwt(token)) found.refreshToken = token;
  };

  const applyPair = (key, value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const name = normalizeKey(key);
    if (ACCESS_KEYS.has(name)) setAccess(value);
    else if (REFRESH_KEYS.has(name)) setRefresh(value);
    else if (DEVICE_KEYS.has(name)) found.deviceToken ||= value.trim();
    else if (USER_KEYS.has(name)) found.userId ||= value.trim();
  };

  // JSON / header array form.
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const walk = (node, depth) => {
        if (!node || depth > 6) return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item, depth + 1);
          return;
        }
        if (typeof node !== 'object') return;
        if (typeof node.name === 'string' && typeof node.value === 'string') applyPair(node.name, node.value);
        for (const [key, value] of Object.entries(node)) {
          if (typeof value === 'string') applyPair(key, value);
          else walk(value, depth + 1);
        }
      };
      walk(parsed, 0);
    } catch {
      /* not JSON, fall through */
    }
  }

  // `Header: value` lines.
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    applyPair(match[1], match[2]);
  }

  // Any bare JWT in the input.
  for (const token of text.match(JWT_RE) || []) {
    if (token === found.accessToken || token === found.refreshToken) continue;
    const payload = decodeJwt(token);
    if (!payload) continue;
    if (String(payload.typ || '').toLowerCase() === 'offline') setRefresh(token);
    else setAccess(token);
  }

  // A refresh token is not an access token, even if the classifier guessed so.
  if (found.accessToken && found.refreshToken && found.accessToken === found.refreshToken) {
    found.accessToken = '';
  }

  return found;
}
