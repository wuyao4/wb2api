import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, CONFIG_PATH } from './config.js';
import { WorkBuddyClient } from './workbuddy.js';
import { AccountPool } from './pool.js';
import { log, warn, error } from './logger.js';
import { prepareChatBody, relayOpenAIStream, collectOpenAICompletion } from './openai.js';
import {
  anthropicToOpenAI,
  openAIToAnthropicMessage,
  relayAnthropicStream,
  anthropicError
} from './anthropic.js';
import { extractCredentials, profileFromToken, generateApiKey, maskToken } from './credentials.js';
import { recordRequest, getStats, getLogs } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

let config = loadConfig();

function persist(updated) {
  try {
    saveConfig(updated || config);
  } catch (err) {
    warn(`could not persist config: ${err.message}`);
  }
}

const client = new WorkBuddyClient(config, (updated) => persist(updated));
const pool = new AccountPool(config, client, (updated) => persist(updated));
const loginStates = new Map();
const loginInflight = new Map();

function applyCors(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendOpenAIError(res, status, message, { type = 'upstream_error', code = null } = {}) {
  sendJson(res, status, { error: { message, type, code } });
}

function isLoopback(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isAdminAllowed(req) {
  const expected = config.server.adminToken;
  if (expected) {
    const provided = req.headers['x-admin-token'] || req.headers.authorization || '';
    return String(provided).replace(/^Bearer\s+/i, '').trim() === expected;
  }
  return isLoopback(req);
}

function isAuthorized(req) {
  const keys = config.server.apiKeys || [];
  if (!keys.length) return true;
  const header = req.headers.authorization || req.headers['x-api-key'] || '';
  const token = String(header).replace(/^Bearer\s+/i, '').trim();
  return keys.includes(token);
}

function publicBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(
    req.headers['x-forwarded-host'] || req.headers.host || `${config.server.host}:${config.server.port}`
  )
    .split(',')[0]
    .trim();
  return `${proto}://${host}/v1`;
}

function readJson(req) {
  const limit = (config.server.requestBodyLimitMb || 128) * 1024 * 1024;
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

function abortOnDisconnect(res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort(new Error('client disconnected'));
  });
  return controller.signal;
}

async function readUpstreamError(upstream) {
  const text = await upstream.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  const message = json?.msg || json?.message || text.slice(0, 500) || `upstream returned ${upstream.status}`;
  const detail = [
    message,
    json?.code != null ? `(code ${json.code})` : '',
    json?.requestId ? `[request ${json.requestId}]` : ''
  ]
    .filter(Boolean)
    .join(' ');
  const err = new Error(detail);
  err.status = upstream.status;
  err.code = json?.code ?? null;
  return err;
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR)) return false;
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

async function handleOpenAIChat(req, res) {
  const body = await readJson(req);
  if (!Array.isArray(body.messages)) {
    return sendOpenAIError(res, 400, '`messages` must be an array', { type: 'invalid_request_error' });
  }
  if (!config.server.running) {
    return sendOpenAIError(res, 503, '反代尚未启动，请打开控制台点击「启动反代」。', {
      type: 'service_unavailable'
    });
  }

  const requestedModel = body.model || config.models.default;
  const upstreamModel = client.resolveModel(requestedModel);
  const upstreamBody = prepareChatBody(config, body, upstreamModel);
  const conversationId = req.headers['x-conversation-id'] || body.conversation_id;
  const sessionKey = pool.sessionKey(req.headers, upstreamBody);
  const signal = abortOnDisconnect(res);
  const started = Date.now();

  let slot;
  try {
    slot = await pool.chat(upstreamBody, { signal, conversationId }, sessionKey);
  } catch (err) {
    if (signal.aborted) return;
    warn(`chat failed before response: ${err.message}`);
    recordRequest({
      kind: 'chat',
      model: requestedModel,
      upstreamModel,
      stream: !!body.stream,
      status: err.status || 502,
      durationMs: Date.now() - started,
      error: err.message
    });
    return sendOpenAIError(res, err.status || 502, err.message, { type: 'upstream_connection_error' });
  }

  const { res: upstream, release, model, account } = slot;
  let usage = null;
  let errorMessage = null;
  let firstTokenMs = null;
  const markFirstToken = () => {
    if (firstTokenMs === null) firstTokenMs = Date.now() - started;
  };

  try {
    if (!upstream.ok) {
      const err = await readUpstreamError(upstream);
      errorMessage = err.message;
      const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : upstream.status;
      const message =
        upstream.status === 429
          ? `${err.message} - WorkBuddy 限流 / 模型繁忙。请稍后重试、切换模型，或配置 models.fallback。`
          : err.message;
      return sendOpenAIError(res, status, message, { code: err.code });
    }

    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      await relayOpenAIStream({
        body: upstream.body,
        res,
        requestedModel,
        upstreamModel: model,
        onFirstChunk: markFirstToken,
        onUsage: (value) => {
          usage = value;
        }
      });
    } else {
      const completion = await collectOpenAICompletion({
        body: upstream.body,
        requestedModel,
        onFirstChunk: markFirstToken
      });
      usage = completion.usage;
      sendJson(res, 200, completion);
    }
  } catch (err) {
    if (signal.aborted) return;
    errorMessage = err.message;
    error(`chat stream failed: ${err.message}`);
    if (!res.headersSent) {
      sendOpenAIError(res, 502, err.message);
    } else {
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_error' } })}\n\n`);
      res.write('data: [DONE]\n\n');
    }
  } finally {
    release();
    recordRequest({
      kind: 'chat',
      model: requestedModel,
      upstreamModel: model,
      account: account?.label || '',
      stream: !!body.stream,
      status: res.statusCode || 200,
      durationMs: Date.now() - started,
      ttfbMs: firstTokenMs,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      error: errorMessage
    });
    if (config.logging.requests) {
      const parts = [
        `${res.statusCode || 200}`,
        `model=${requestedModel}${requestedModel !== model ? `->${model}` : ''}`,
        `account=${account?.label || '-'}`,
        `stream=${!!body.stream}`,
        `${Date.now() - started}ms`
      ];
      if (firstTokenMs !== null) parts.push(`ttfb=${firstTokenMs}ms`);
      if (usage) parts.push(`tokens=${usage.prompt_tokens ?? '?'}/${usage.completion_tokens ?? '?'}`);
      log(`chat ${parts.join(' ')}`);
    }
    if (!res.writableEnded) res.end();
  }
}

async function handleAnthropicMessages(req, res) {
  const request = await readJson(req);
  if (!Array.isArray(request.messages)) {
    return anthropicError(res, 400, '`messages` must be an array', 'invalid_request_error');
  }
  if (!config.server.running) {
    return anthropicError(res, 503, '反代尚未启动，请打开控制台点击「启动反代」。', 'service_unavailable');
  }

  const requestedModel = request.model || config.models.default;
  const upstreamModel = client.resolveModel(requestedModel);
  const converted = anthropicToOpenAI(request);
  const upstreamBody = prepareChatBody(config, converted, upstreamModel);
  const sessionKey = pool.sessionKey(req.headers, upstreamBody);
  const signal = abortOnDisconnect(res);
  const started = Date.now();

  let slot;
  try {
    slot = await pool.chat(upstreamBody, { signal }, sessionKey);
  } catch (err) {
    if (signal.aborted) return;
    warn(`messages failed before response: ${err.message}`);
    recordRequest({
      kind: 'messages',
      model: requestedModel,
      upstreamModel,
      stream: !!request.stream,
      status: err.status || 502,
      durationMs: Date.now() - started,
      error: err.message
    });
    return anthropicError(res, err.status || 502, err.message);
  }

  const { res: upstream, release, account } = slot;
  let usage = null;
  let errorMessage = null;
  let firstTokenMs = null;
  const markFirstToken = () => {
    if (firstTokenMs === null) firstTokenMs = Date.now() - started;
  };

  try {
    if (!upstream.ok) {
      const err = await readUpstreamError(upstream);
      errorMessage = err.message;
      return anthropicError(res, upstream.status >= 500 ? 502 : upstream.status, err.message);
    }

    if (request.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      await relayAnthropicStream({
        body: upstream.body,
        res,
        requestedModel,
        onFirstChunk: markFirstToken,
        onUsage: (value) => {
          usage = value;
        }
      });
    } else {
      const completion = await collectOpenAICompletion({
        body: upstream.body,
        requestedModel,
        onFirstChunk: markFirstToken
      });
      usage = completion.usage;
      sendJson(res, 200, openAIToAnthropicMessage(completion, requestedModel));
    }
  } catch (err) {
    if (signal.aborted) return;
    errorMessage = err.message;
    error(`messages stream failed: ${err.message}`);
    if (!res.headersSent) anthropicError(res, 502, err.message);
    else res.end();
  } finally {
    release();
    recordRequest({
      kind: 'messages',
      model: requestedModel,
      upstreamModel,
      account: account?.label || '',
      stream: !!request.stream,
      status: res.statusCode || 200,
      durationMs: Date.now() - started,
      ttfbMs: firstTokenMs,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      error: errorMessage
    });
    if (config.logging.requests) {
      const parts = [
        `${res.statusCode || 200}`,
        `model=${requestedModel}`,
        `account=${account?.label || '-'}`,
        `stream=${!!request.stream}`,
        `${Date.now() - started}ms`
      ];
      if (firstTokenMs !== null) parts.push(`ttfb=${firstTokenMs}ms`);
      if (usage) parts.push(`tokens=${usage.prompt_tokens ?? '?'}/${usage.completion_tokens ?? '?'}`);
      log(`messages ${parts.join(' ')}`);
    }
    if (!res.writableEnded) res.end();
  }
}

async function handleModels(req, res) {
  const data = await client.listOpenAIModels();
  sendJson(res, 200, { object: 'list', data });
}

async function handleAdminStatus(req, res) {
  const profile = profileFromToken(config.upstream.accessToken);
  const expiresAt = client.tokenExpiresAt();
  sendJson(res, 200, {
    ok: true,
    running: !!config.server.running,
    canAutoLogin: true,
    hasDeviceToken: !!config.upstream.deviceToken,
    baseUrl: publicBaseUrl(req),
    apiKey: config.server.apiKeys?.[0] || '',
    defaultModel: config.models.default,
    models: {
      contextWindow: config.models.contextWindow
    },
    user: profile
      ? { username: profile.username, email: profile.email, sub: profile.sub }
      : null,
    token: {
      expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
      expired: expiresAt ? expiresAt * 1000 < Date.now() : null,
      hasRefreshToken: !!config.upstream.refreshToken,
      maskedAccessToken: maskToken(config.upstream.accessToken)
    },
    accounts: pool.status(),
    routing: {
      sessionAffinity: config.routing?.sessionAffinity !== false,
      affinityTtlMinutes: config.routing?.affinityTtlMinutes,
      failover: config.routing?.failover !== false,
      sessions: pool.sessionCount()
    },
    stats: getStats(),
    config: {
      configPath: CONFIG_PATH,
      host: config.server.host,
      port: config.server.port,
      authEnabled: !!config.server.apiKeys?.length,
      adminProtected: !!config.server.adminToken
    }
  });
}

function pluginHeaders(deviceToken = config.upstream.deviceToken) {
  const upstream = config.upstream;
  const headers = {
    'X-No-Authorization': 'true',
    'X-Product': upstream.product || 'SaaS',
    'X-Domain': upstream.domain || 'www.workbuddy.ai',
    Accept: 'application/json',
    'User-Agent': upstream.client?.userAgent || 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0'
  };
  if (deviceToken) headers['X-Device-Token'] = deviceToken;
  return headers;
}

function pruneLoginStates() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [state, value] of loginStates) {
    if (value.at < cutoff) loginStates.delete(state);
  }
}

async function applyCredentialSource(source, overrides = {}) {
  const creds = extractCredentials(typeof source === 'string' ? source : '');
  if (overrides.deviceToken) creds.deviceToken = String(overrides.deviceToken).trim();
  if (overrides.userId) creds.userId = String(overrides.userId).trim();

  if (!creds.accessToken && !creds.refreshToken) {
    throw Object.assign(
      new Error('没有识别到 JWT。请粘贴 access token、refresh token，或包含 Authorization 的请求头。'),
      { status: 400 }
    );
  }

  const candidate = structuredClone(config);
  if (creds.accessToken) candidate.upstream.accessToken = creds.accessToken;
  if (creds.refreshToken) candidate.upstream.refreshToken = creds.refreshToken;
  if (creds.deviceToken) candidate.upstream.deviceToken = creds.deviceToken;
  if (creds.userId) candidate.upstream.userId = creds.userId;

  // A pasted access token for a different account must not inherit the old
  // account's refresh token.
  if (creds.accessToken && !creds.refreshToken) {
    const newSub = profileFromToken(creds.accessToken)?.sub;
    const oldSub = profileFromToken(config.upstream.refreshToken)?.sub;
    if (newSub && oldSub && newSub !== oldSub) candidate.upstream.refreshToken = '';
  }

  const temp = new WorkBuddyClient(candidate, () => {});
  let warning = null;

  if (creds.refreshToken) {
    try {
      await temp.refreshToken();
    } catch (err) {
      warning = `刷新令牌不可用：${err.message}`;
      if (!creds.accessToken) throw Object.assign(new Error(warning), { status: 400 });
    }
  }

  if (!candidate.upstream.accessToken) {
    throw Object.assign(new Error('未能获得可用的 access token。'), { status: 400 });
  }

  try {
    await temp.fetchProductConfigStrict();
  } catch (err) {
    throw Object.assign(new Error(`Token 校验失败：${err.message}`), { status: 400 });
  }

  const profile = profileFromToken(candidate.upstream.accessToken);
  if (!candidate.upstream.userId && profile?.sub) candidate.upstream.userId = profile.sub;

  config.upstream.accessToken = candidate.upstream.accessToken;
  config.upstream.refreshToken = candidate.upstream.refreshToken;
  config.upstream.deviceToken = candidate.upstream.deviceToken;
  config.upstream.userId = candidate.upstream.userId;
  persist(config);
  client.setConfig(config);
  pool.setConfig(config, { rebuild: false });

  log(`credentials saved for ${profile?.username || profile?.sub || 'unknown user'}`);

  const expiresAt = client.tokenExpiresAt();
  return {
    warning,
    user: profile ? { username: profile.username, email: profile.email, sub: profile.sub } : null,
    token: {
      expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
      hasRefreshToken: !!config.upstream.refreshToken
    }
  };
}

async function applyTokensToAccount(accountId, accessToken, refreshToken, deviceToken, label) {
  config.accounts = config.accounts || [];
  const entry = accountId ? config.accounts.find((account) => account.id === accountId) : null;
  if (accountId && !entry) {
    throw Object.assign(new Error('账号不存在，可能已被删除'), { status: 404 });
  }

  const maxConcurrency =
    Number(entry?.maxConcurrency) > 0
      ? Number(entry.maxConcurrency)
      : Number(config.routing?.defaultAccountConcurrency) || 2;

  const targetConfig = structuredClone(config);
  targetConfig.upstream = {
    ...config.upstream,
    accessToken: accessToken || entry?.accessToken || '',
    refreshToken: refreshToken || entry?.refreshToken || '',
    deviceToken: deviceToken || entry?.deviceToken || config.upstream.deviceToken,
    userId: entry?.userId || '',
    maxConcurrency
  };

  const temp = new WorkBuddyClient(targetConfig, () => {});
  let warning = null;

  if (targetConfig.upstream.refreshToken) {
    try {
      await temp.refreshToken();
    } catch (err) {
      warning = `刷新令牌不可用：${err.message}`;
      if (!targetConfig.upstream.accessToken) {
        throw Object.assign(new Error(warning), { status: 400 });
      }
    }
  }

  if (!targetConfig.upstream.accessToken) {
    throw Object.assign(new Error('未能获得可用的 access token。'), { status: 400 });
  }

  try {
    await temp.fetchProductConfigStrict();
  } catch (err) {
    throw Object.assign(new Error(`Token 校验失败：${err.message}`), { status: 400 });
  }

  const profile = profileFromToken(temp.upstream.accessToken);

  // Re-adding the same WorkBuddy account should update it instead of creating
  // a duplicate pool entry.
  let target = entry;
  if (!target && profile?.sub) {
    if (config.upstream.userId === profile.sub) {
      config.upstream.accessToken = temp.upstream.accessToken;
      config.upstream.refreshToken = temp.upstream.refreshToken;
      config.upstream.deviceToken = temp.upstream.deviceToken;
      config.upstream.userId = profile.sub;
      persist(config);
      client.setConfig(config);
      pool.setConfig(config, { rebuild: false });
      const expiresAt = temp.tokenExpiresAt();
      const label = config.upstream.label || '主账号';
      log(`primary account updated (${profile.username || profile.sub})`);
      return {
        warning,
        accountId: 'primary',
        label,
        user: { username: profile.username, email: profile.email, sub: profile.sub },
        token: {
          expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
          hasRefreshToken: !!config.upstream.refreshToken
        }
      };
    }
    target = (config.accounts || []).find((account) => account.userId === profile.sub) || null;
  }

  const data = {
    accessToken: temp.upstream.accessToken,
    refreshToken: temp.upstream.refreshToken,
    deviceToken: temp.upstream.deviceToken,
    userId: profile?.sub || target?.userId || '',
    label: target?.label || label || profile?.username || 'WorkBuddy 账号'
  };

  let id;
  if (target) {
    Object.assign(target, data);
    id = target.id;
  } else {
    id = randomUUID();
    config.accounts.push({ id, enabled: true, maxConcurrency, ...data });
  }

  persist(config);
  pool.setConfig(config, { rebuild: true });

  const expiresAt = temp.tokenExpiresAt();
  log(`account ${data.label} saved (${profile?.username || profile?.sub || 'unknown'})`);

  return {
    warning,
    accountId: id,
    label: data.label,
    user: profile
      ? { username: profile.username, email: profile.email, sub: profile.sub }
      : null,
    token: {
      expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
      hasRefreshToken: !!data.refreshToken
    }
  };
}

async function handleCredentials(req, res) {
  const body = await readJson(req);
  try {
    const result = await applyCredentialSource(body.source, {
      deviceToken: body.deviceToken,
      userId: body.userId
    });
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    sendJson(res, err.status || 400, { ok: false, error: err.message });
  }
}

async function handleLoginStart(req, res) {
  pruneLoginStates();
  const body = await readJson(req);
  const createNew = Boolean(body.createNew);
  const accountId = createNew ? null : String(body.accountId || 'primary');

  let targetAccount = null;
  if (!createNew && accountId !== 'primary') {
    targetAccount = (config.accounts || []).find((account) => account.id === accountId);
    if (!targetAccount) {
      return sendJson(res, 404, { ok: false, status: 'error', error: '账号不存在' });
    }
  }

  const deviceToken = targetAccount?.deviceToken || config.upstream.deviceToken || '';
  const label = createNew
    ? String(body.label || '')
    : targetAccount?.label || config.upstream.label || '主账号';

  const base = config.upstream.baseUrl.replace(/\/+$/, '');
  let origin = 'https://www.workbuddy.ai';
  try {
    origin = new URL(base).origin;
  } catch {
    /* keep default */
  }
  const version = config.upstream.client?.ideVersion || '5.8.4';

  try {
    const response = await fetch(
      `${base}/v2/plugin/auth/state?platform=workbuddy-ai&version=${encodeURIComponent(version)}`,
      { method: 'POST', headers: pluginHeaders(deviceToken), signal: AbortSignal.timeout(20000) }
    );
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (!response.ok || json?.code !== 0 || !json?.data?.state || !json?.data?.authUrl) {
      throw new Error(json?.msg || `创建登录会话失败（${response.status}）`);
    }
    const authUrl = String(json.data.authUrl);
    if (!authUrl.startsWith(`${origin}/`)) throw new Error('上游返回了非预期的授权地址');

    loginStates.set(json.data.state, {
      at: Date.now(),
      accountId,
      createNew,
      label,
      deviceToken
    });
    sendJson(res, 200, {
      ok: true,
      state: json.data.state,
      authUrl,
      mode: createNew ? 'new' : accountId
    });
  } catch (err) {
    sendJson(res, 502, { ok: false, status: 'error', error: err.message });
  }
}

async function handleLoginStatus(req, res) {
  pruneLoginStates();
  const requestUrl = new URL(req.url, 'http://localhost');
  const state = requestUrl.searchParams.get('state') || '';
  if (!state) {
    return sendJson(res, 400, { ok: false, status: 'error', error: '缺少 state' });
  }

  const session = loginStates.get(state);
  if (!session) {
    return sendJson(res, 400, {
      ok: false,
      status: 'error',
      error: '登录会话不存在或已过期，请重新发起登录'
    });
  }
  if (session.result) {
    return sendJson(res, 200, { ok: true, status: 'success', ...session.result });
  }
  if (session.error) {
    return sendJson(res, 502, { ok: false, status: 'error', error: session.error });
  }
  if (loginInflight.has(state)) {
    try {
      const result = await loginInflight.get(state);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 502, { ok: false, status: 'error', error: err.message });
    }
  }

  const task = (async () => {
    const base = config.upstream.baseUrl.replace(/\/+$/, '');
    const response = await fetch(
      `${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
      { headers: pluginHeaders(session.deviceToken), signal: AbortSignal.timeout(20000) }
    );
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }

    if (json?.code === 11217) return { status: 'pending' };
    if (!response.ok || json?.code !== 0) {
      throw new Error(json?.msg || `获取登录 token 失败（${response.status}）`);
    }

    const accessToken = json?.data?.accessToken || json?.data?.access_token;
    const refreshToken = json?.data?.refreshToken || json?.data?.refresh_token;
    if (!accessToken) throw new Error('登录已完成，但上游没有返回 access token');

    let result;
    if (session.createNew || (session.accountId && session.accountId !== 'primary')) {
      result = await applyTokensToAccount(
        session.accountId,
        accessToken,
        refreshToken,
        session.deviceToken,
        session.label
      );
    } else {
      const source = [
        `Authorization: Bearer ${accessToken}`,
        refreshToken ? `X-Refresh-Token: ${refreshToken}` : ''
      ]
        .filter(Boolean)
        .join('\n');
      result = await applyCredentialSource(source);
      result = {
        ...result,
        accountId: 'primary',
        label: config.upstream.label || '主账号'
      };
    }
    return { status: 'success', ...result };
  })();

  loginInflight.set(state, task);
  try {
    const result = await task;
    if (result.status === 'success') session.result = result;
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    session.error = err.message;
    sendJson(res, 502, { ok: false, status: 'error', error: err.message });
  } finally {
    loginInflight.delete(state);
  }
}

async function handleAccountToggle(req, res) {
  const body = await readJson(req);
  const id = String(body.id || '');
  if (!id) return sendJson(res, 400, { ok: false, error: '缺少账号 id' });
  const enabled = body.enabled !== false;

  if (id === 'primary') {
    config.upstream.enabled = enabled;
  } else {
    const entry = (config.accounts || []).find((account) => account.id === id);
    if (!entry) return sendJson(res, 404, { ok: false, error: '账号不存在' });
    entry.enabled = enabled;
  }

  persist(config);
  pool.setConfig(config, { rebuild: true });
  sendJson(res, 200, { ok: true, accounts: pool.status() });
}

async function handleAccountUpdate(req, res) {
  const body = await readJson(req);
  const id = String(body.id || '');
  if (!id) return sendJson(res, 400, { ok: false, error: '缺少账号 id' });

  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
  const maxConcurrency = Number(body.maxConcurrency);
  if (body.maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 20)) {
    return sendJson(res, 400, { ok: false, error: 'maxConcurrency 必须是 1-20 的整数' });
  }

  if (id === 'primary') {
    if (label) config.upstream.label = label;
    if (body.maxConcurrency !== undefined) config.upstream.maxConcurrency = maxConcurrency;
    persist(config);
    client.setConfig(config);
    pool.setConfig(config, { rebuild: false });
  } else {
    const entry = (config.accounts || []).find((account) => account.id === id);
    if (!entry) return sendJson(res, 404, { ok: false, error: '账号不存在' });
    if (label) entry.label = label;
    if (body.maxConcurrency !== undefined) entry.maxConcurrency = maxConcurrency;
    persist(config);
    pool.setConfig(config, { rebuild: true });
  }

  sendJson(res, 200, { ok: true, accounts: pool.status() });
}

async function handleAccountRemove(req, res) {
  const body = await readJson(req);
  const id = String(body.id || '');
  if (!id) return sendJson(res, 400, { ok: false, error: '缺少账号 id' });
  if (id === 'primary') {
    return sendJson(res, 400, { ok: false, error: '主账号不能删除，可以停用' });
  }

  const index = (config.accounts || []).findIndex((account) => account.id === id);
  if (index === -1) return sendJson(res, 404, { ok: false, error: '账号不存在' });
  config.accounts.splice(index, 1);
  persist(config);
  pool.dropAccountSessions(id);
  pool.setConfig(config, { rebuild: true });
  sendJson(res, 200, { ok: true, accounts: pool.status() });
}

async function handleStart(req, res) {
  const body = await readJson(req);

  const startAccounts = pool
    .all()
    .filter(
      (account) =>
        account.enabled &&
        (account.client.upstream.accessToken || account.client.upstream.refreshToken)
    );
  if (!startAccounts.length) {
    return sendJson(res, 400, { ok: false, error: '请先登录或添加至少一个 WorkBuddy 账号。' });
  }

  const startAccount = startAccounts.find((account) => account.isPrimary) || startAccounts[0];
  let startClient = startAccount.client;
  let productConfig = null;
  let startError = null;

  for (const account of startAccounts) {
    const candidate = account.client;
    if (candidate.upstream.refreshToken) {
      try {
        await candidate.refreshToken();
      } catch (err) {
        if (!candidate.upstream.accessToken) {
          startError = err;
          continue;
        }
        warn(`refresh during start failed, using existing access token: ${err.message}`);
      }
    }
    try {
      productConfig = await candidate.fetchProductConfigStrict();
      startClient = candidate;
      break;
    } catch (err) {
      startError = err;
    }
  }

  if (!productConfig) {
    return sendJson(res, 400, {
      ok: false,
      error: `凭据校验失败：${startError?.message || '没有可用账号'}`
    });
  }

  const models = Array.isArray(productConfig.models) ? productConfig.models : [];
  const defaultModel = String(body.defaultModel || config.models.default || 'deepseek-v4.1-flash').trim();
  if (!defaultModel) {
    return sendJson(res, 400, { ok: false, error: '请选择默认模型。' });
  }

  const upstreamModel = client.resolveModel(defaultModel);
  const modelInfo = models.find((model) => model.id === upstreamModel) || models.find((model) => model.id === defaultModel);
  const requestedContext = Number(body.contextWindow || 0);
  if (requestedContext > 0) {
    const maxContext = Number(modelInfo?.maxInputTokens || modelInfo?.maxAllowedSize || 0);
    const supported = modelInfo?.contextWindow?.supportedLengths || [];
    if (supported.length && !supported.includes(requestedContext)) {
      return sendJson(res, 400, {
        ok: false,
        error: `该模型支持的上下文长度为 ${supported.map((value) => `${value / 1000}K`).join(' / ')}。`
      });
    }
    if (maxContext && requestedContext > maxContext) {
      return sendJson(res, 400, {
        ok: false,
        error: `上下文长度不能超过模型上限 ${maxContext}。`
      });
    }
    config.models.contextWindow.overrides = config.models.contextWindow.overrides || {};
    config.models.contextWindow.overrides[upstreamModel] = requestedContext;
  }

  let apiKey = String(body.apiKey || '').trim();
  if (apiKey === 'sk-wb2api-local') apiKey = '';
  if (apiKey && !/^[A-Za-z0-9._-]{8,128}$/.test(apiKey)) {
    return sendJson(res, 400, {
      ok: false,
      error: 'API Key 只能包含字母、数字、点、下划线、短横线，长度 8-128。'
    });
  }
  if (!apiKey) {
    apiKey = config.server.apiKeys.find((key) => key && key !== 'sk-wb2api-local') || generateApiKey();
  }

  config.server.apiKeys = [apiKey];
  config.models.default = defaultModel;
  config.server.running = true;
  persist(config);

  log(`proxy started (default model: ${defaultModel})`);

  const effectiveContext =
    config.models.contextWindow.overrides?.[upstreamModel] ?? config.models.contextWindow.default;

  sendJson(res, 200, {
    ok: true,
    running: true,
    baseUrl: publicBaseUrl(req),
    apiKey,
    defaultModel,
    contextWindow: effectiveContext,
    modelCount: models.length
  });
}

function handleStop(req, res) {
  config.server.running = false;
  persist(config);
  log('proxy stopped');
  sendJson(res, 200, { ok: true, running: false });
}

function handleGenerateKey(req, res) {
  const apiKey = generateApiKey();
  config.server.apiKeys = [apiKey];
  persist(config);
  sendJson(res, 200, { ok: true, apiKey });
}

async function handleAdminModels(req, res) {
  try {
    const models = await client.listOpenAIModels();
    sendJson(res, 200, { ok: true, data: models });
  } catch (err) {
    sendJson(res, 502, { ok: false, error: err.message });
  }
}

async function handleAdminRefresh(req, res) {
  try {
    await client.refreshToken();
    sendJson(res, 200, {
      ok: true,
      tokenExpiresAt: new Date(client.tokenExpiresAt() * 1000).toISOString()
    });
  } catch (err) {
    sendJson(res, 502, { ok: false, error: err.message });
  }
}

function handleAdminReload(req, res) {
  try {
    config = loadConfig();
    client.setConfig(config);
    pool.setConfig(config, { rebuild: true });
    sendJson(res, 200, { ok: true, configPath: CONFIG_PATH });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (req.method === 'GET' && !pathname.startsWith('/v1') && !pathname.startsWith('/admin')) {
      if (await serveStatic(req, res, pathname)) return;
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, uptime: process.uptime(), running: !!config.server.running });
    }

    if (pathname.startsWith('/admin')) {
      if (!isAdminAllowed(req)) {
        return sendJson(res, 403, {
          ok: false,
          error: '管理接口仅允许本机访问。远程访问请配置 server.adminToken 并携带 X-Admin-Token。'
        });
      }

      if (req.method === 'GET' && pathname === '/admin/status') return await handleAdminStatus(req, res);
      if (req.method === 'POST' && pathname === '/admin/credentials') return await handleCredentials(req, res);
      if (req.method === 'POST' && pathname === '/admin/login/start') return await handleLoginStart(req, res);
      if (req.method === 'GET' && pathname === '/admin/login/status') return await handleLoginStatus(req, res);
      if (req.method === 'POST' && pathname === '/admin/accounts/toggle') return await handleAccountToggle(req, res);
      if (req.method === 'POST' && pathname === '/admin/accounts/update') return await handleAccountUpdate(req, res);
      if (req.method === 'POST' && pathname === '/admin/accounts/remove') return await handleAccountRemove(req, res);
      if (req.method === 'POST' && pathname === '/admin/start') return await handleStart(req, res);
      if (req.method === 'POST' && pathname === '/admin/stop') return handleStop(req, res);
      if (req.method === 'POST' && pathname === '/admin/key') return handleGenerateKey(req, res);
      if (req.method === 'GET' && pathname === '/admin/models') return await handleAdminModels(req, res);
      if (req.method === 'GET' && pathname === '/admin/logs') {
        return sendJson(res, 200, { ok: true, logs: getLogs(60) });
      }
      if (req.method === 'POST' && pathname === '/admin/refresh') return await handleAdminRefresh(req, res);
      if (req.method === 'POST' && pathname === '/admin/reload') return handleAdminReload(req, res);

      return sendJson(res, 404, { ok: false, error: `admin route not found: ${req.method} ${pathname}` });
    }

    if (!isAuthorized(req)) {
      return sendJson(res, 401, {
        error: { message: 'invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' }
      });
    }

    if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
      return await handleOpenAIChat(req, res);
    }
    if (req.method === 'POST' && pathname === '/v1/messages') {
      return await handleAnthropicMessages(req, res);
    }
    if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
      return await handleModels(req, res);
    }

    sendJson(res, 404, {
      error: { message: `no route for ${req.method} ${pathname}`, type: 'invalid_request_error' }
    });
  } catch (err) {
    error(`${req.method} ${pathname}: ${err.stack || err.message}`);
    if (!res.headersSent) {
      sendJson(res, err.status || 500, {
        error: { message: err.message, type: 'internal_error' }
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 72000;
server.noDelay = true;

server.listen(config.server.port, config.server.host, () => {
  log(`workbuddy2api listening on http://${config.server.host}:${config.server.port}`);
  log(`dashboard: http://127.0.0.1:${config.server.port}/`);
  log(`default model: ${config.models.default}, proxy: ${config.server.running ? 'running' : 'stopped'}`);
  log(`config: ${CONFIG_PATH}`);
  if (config.upstream.accessToken || config.upstream.refreshToken) {
    client.ensureToken().catch((err) => warn(`token check failed: ${err.message}`));
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
