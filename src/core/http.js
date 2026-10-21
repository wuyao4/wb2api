import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

export function applyCors(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

export function sendOpenAIError(res, status, message, { type = 'upstream_error', code = null } = {}) {
  sendJson(res, status, { error: { message, type, code } });
}

export function isLoopback(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function isAdminAllowed(req, config) {
  const expected = config.server.adminToken;
  if (expected) {
    const provided = req.headers['x-admin-token'] || req.headers.authorization || '';
    return String(provided).replace(/^Bearer\s+/i, '').trim() === expected;
  }
  return isLoopback(req);
}

export function isAuthorized(req, config) {
  const keys = config.server.apiKeys || [];
  if (!keys.length) return true;
  const header = req.headers.authorization || req.headers['x-api-key'] || '';
  const token = String(header).replace(/^Bearer\s+/i, '').trim();
  return keys.includes(token);
}

export function publicBaseUrl(req, config) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(
    req.headers['x-forwarded-host'] || req.headers.host || `${config.server.host}:${config.server.port}`
  )
    .split(',')[0]
    .trim();
  return `${proto}://${host}/v1`;
}

export function readJson(req, limitMb = 128) {
  const limit = Math.max(1, Number(limitMb) || 128) * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error(`request body exceeds ${limit} bytes`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(Object.assign(new Error(`invalid JSON body: ${err.message}`), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function abortOnDisconnect(res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort(new Error('client disconnected'));
  });
  return controller.signal;
}

/** Serve a file from `root`; returns false when the path is missing or escapes. */
export function serveStatic(root, req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root))) return false;

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const data = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-store'
  });
  res.end(data);
  return true;
}
