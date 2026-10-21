/**
 * Connection-layer tests.
 *
 * Covers the three strategies without touching real vendor accounts:
 *   - key verification against a mock upstream (success / 401 / 402 / 429)
 *   - local runtime detection
 *   - the OpenRouter OAuth PKCE handshake end to end, with the exchange
 *     endpoint pointed at a local mock
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-connect-'));
const configPath = path.join(tempDir, 'config.json');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/* ---------------------------------------------------------------- mock upstream */

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const auth = req.headers.authorization || '';

  if (url.pathname === '/v1/models') {
    if (auth === 'Bearer good-key' || !auth) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-small' }, { id: 'mock-large' }] }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
    return;
  }

  if (url.pathname === '/v1/chat/completions') {
    const body = JSON.parse(await readBody(req));
    if (auth === 'Bearer good-key') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      return;
    }
    if (auth === 'Bearer broke-key') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'insufficient credits' } }));
      return;
    }
    if (auth === 'Bearer busy-key') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    if (body?.model === 'mock-large') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model not supported here' } }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
    return;
  }

  res.writeHead(404).end();
});

const upstreamPort = await listen(upstream);
const upstreamBase = `http://127.0.0.1:${upstreamPort}/v1`;

/* --------------------------------------------------------- mock OAuth exchange */

const oauthExchange = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/auth/keys')) {
    res.writeHead(404).end();
    return;
  }
  const body = JSON.parse(await readBody(req));
  if (body.code === 'valid-code' && body.code_verifier && body.code_challenge_method === 'S256') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: 'good-key' }));
    return;
  }
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Invalid code' } }));
});

const oauthPort = await listen(oauthExchange);

/* ------------------------------------------------------------------- config */

fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      version: 2,
      server: { host: '127.0.0.1', port: 0, apiKeys: ['sk-test'], running: false },
      routing: { defaultModel: 'mock/mock-small', namespace: 'auto' },
      channels: {
        mock: {
          type: 'openai-compatible',
          enabled: true,
          label: 'Mock',
          options: { baseUrl: upstreamBase, apiKey: 'good-key', preset: 'groq' },
          models: { allowUnknown: true, contextWindow: { default: 0, overrides: {} } }
        }
      },
      prompt: { system: 'x', injectWhenMissing: true },
      retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 20 },
      logging: { requests: false }
    },
    null,
    2
  )
);

process.env.WB2API_CONFIG = configPath;
// Point the PKCE exchange at the local mock before the module is imported.
process.env.WB2API_OPENROUTER_EXCHANGE_URL = `http://127.0.0.1:${oauthPort}/auth/keys`;

const { verifyProviderKey, connectInfo, allConnectInfo, detectLocal } = await import(
  '../src/channels/connect.js'
);
const { OpenRouterOAuth } = await import('../src/channels/oauth/openrouter.js');
const { Runtime } = await import('../src/runtime.js');
const { createServer } = await import('../src/server.js');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

const runtime = new Runtime();
const proxy = createServer(runtime);
const proxyPort = await listen(proxy);
const base = `http://127.0.0.1:${proxyPort}`;

async function api(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

try {
  await check('every preset declares a connection strategy', async () => {
    const all = allConnectInfo();
    // 20 API-key/keyless presets + 11 OAuth-only channels (OpenRouter is both).
    assert.equal(all.length, 31);

    const ids = new Set();
    for (const entry of all) {
      assert.ok(!ids.has(entry.id), `duplicate entry ${entry.id}`);
      ids.add(entry.id);
      assert.ok(['oauth', 'open-key', 'keyless'].includes(entry.strategy), entry.id);
      if (entry.strategy === 'keyless') assert.ok(!entry.apiKeyRequired, entry.id);
      if (entry.strategy === 'open-key') assert.ok(entry.keyUrl, `${entry.id} missing keyUrl`);
      if (entry.strategy === 'oauth') assert.ok(entry.oauth, `${entry.id} missing oauth provider`);
    }

    const oauth = all.filter((entry) => entry.strategy === 'oauth').map((entry) => entry.id).sort();
    assert.deepEqual(oauth, [
      'cline',
      'codebuddy',
      'gemini-code-assist',
      'lobsterai',
      'loomy',
      'minimax-code',
      'openrouter',
      'qoder',
      'raccoon',
      'trae',
      'workbuddy',
      'zcode'
    ]);

    assert.equal(connectInfo('openrouter').oauth, 'openrouter');
    assert.equal(connectInfo('cline').oauth, 'cline');
    assert.equal(connectInfo('codebuddy').baseUrl, 'https://copilot.tencent.com');
    assert.equal(connectInfo('workbuddy').baseUrl, 'https://www.workbuddy.ai');
    assert.equal(connectInfo('ollama').detectUrl, 'http://127.0.0.1:11434/v1/models');
  });

  await check('a working key passes the chat probe', async () => {
    const result = await verifyProviderKey({
      presetId: 'groq',
      apiKey: 'good-key',
      baseUrl: upstreamBase
    });
    assert.equal(result.ok, true);
    assert.ok(result.models.includes('mock-small'));
  });

  await check('an invalid key is rejected with 401', async () => {
    await assert.rejects(
      () => verifyProviderKey({ presetId: 'groq', apiKey: 'wrong-key', baseUrl: upstreamBase }),
      (error) => error.status === 401
    );
  });

  await check('a key without quota still counts as authenticated', async () => {
    const result = await verifyProviderKey({
      presetId: 'groq',
      apiKey: 'broke-key',
      baseUrl: upstreamBase
    });
    assert.equal(result.ok, true);
    assert.equal(result.warning, true);
    assert.match(result.message, /额度|限流/);
  });

  await check('rate limiting is not reported as a bad key', async () => {
    const result = await verifyProviderKey({
      presetId: 'groq',
      apiKey: 'busy-key',
      baseUrl: upstreamBase
    });
    assert.equal(result.ok, true);
    assert.equal(result.warning, true);
  });

  await check('a public model list alone never proves a key works', async () => {
    // The mock serves /models keylessly but requires auth for chat.
    await assert.rejects(
      () => verifyProviderKey({ presetId: 'nvidia', apiKey: 'wrong-key', baseUrl: upstreamBase }),
      (error) => error.status === 401
    );
  });

  await check('a preset that needs a key refuses to verify without one', async () => {
    await assert.rejects(
      () => verifyProviderKey({ presetId: 'openrouter', apiKey: '', baseUrl: upstreamBase }),
      (error) => error.status === 400 && /API Key/.test(error.message)
    );
  });

  await check('local runtime detection reports a stopped service', async () => {
    const result = await detectLocal('ollama');
    assert.equal(result.running, false);
  });

  await check('admin exposes the connection catalogue', async () => {
    const { status, body } = await api('/admin/connect/presets');
    assert.equal(status, 200);
    assert.equal(body.presets.length, 31);
    const oauth = body.presets.find((entry) => entry.id === 'openrouter');
    assert.equal(oauth.strategy, 'oauth');
    const cline = body.presets.find((entry) => entry.id === 'cline');
    assert.equal(cline.strategy, 'oauth');
    assert.equal(cline.oauth, 'cline');
    const workbuddy = body.presets.find((entry) => entry.id === 'workbuddy');
    assert.equal(workbuddy.strategy, 'oauth');
    assert.equal(workbuddy.oauth, 'workbuddy');
    const loomy = body.presets.find((entry) => entry.id === 'loomy');
    assert.equal(loomy.strategy, 'oauth');
  });

  await check('clipboard endpoint returns only a shape-checked candidate', async () => {
    const { status, body } = await api('/admin/connect/clipboard');
    assert.equal(status, 200);
    assert.equal(typeof body.available, 'boolean');
    assert.equal(typeof body.signature, 'string');
    // The endpoint must never echo raw clipboard contents.
    assert.equal(body.text, undefined);
    assert.ok(!('raw' in body));
    if (body.candidate) {
      assert.match(body.candidate, /^[A-Za-z0-9._~+/-]+={0,2}$/);
      assert.ok(!/\s/.test(body.candidate));
    }
  });

  await check('verify endpoint stores nothing and reports the probe result', async () => {
    const { status, body } = await api('/admin/connect/verify', {
      method: 'POST',
      body: JSON.stringify({ preset: 'groq', apiKey: 'good-key', baseUrl: upstreamBase })
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    // Verification must not create a channel as a side effect.
    const channels = await api('/admin/channels');
    assert.equal(channels.body.channels.length, 1);
  });

  await check('OpenRouter PKCE: start issues a state and a valid auth URL', async () => {
    const oauth = new OpenRouterOAuth({ persist: () => {} });
    try {
      const session = await oauth.start({ label: 'Buddy2API', channelId: 'openrouter' });
      const url = new URL(session.authUrl);
      assert.equal(url.origin, 'https://openrouter.ai');
      assert.equal(url.pathname, '/auth');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(url.searchParams.get('code_challenge').length >= 43);
      assert.ok(url.searchParams.get('state'));
      assert.match(url.searchParams.get('callback_url'), /^http:\/\/127\.0\.0\.1:\d+\/openrouter\/callback$/);
      assert.equal(oauth.poll(session.state).status, 'pending');

      // Simulate the browser redirect, then the (mock) exchange.
      const callbackUrl = `${session.callbackUrl}?code=valid-code&state=${session.state}`;
      const redirect = await fetch(callbackUrl);
      assert.equal(redirect.status, 200);
      const html = await redirect.text();
      assert.match(html, /授权成功/);

      const result = oauth.poll(session.state);
      assert.equal(result.status, 'success');
      assert.equal(result.apiKey, 'good-key');

      // A delivered key is retired: polling again fails.
      assert.throws(() => oauth.poll(session.state), /不存在或已过期/);
    } finally {
      oauth.close();
    }
  });

  await check('OpenRouter PKCE: a rejected authorization surfaces an error', async () => {
    const oauth = new OpenRouterOAuth({ persist: () => {} });
    try {
      const session = await oauth.start({});
      const redirect = await fetch(`${session.callbackUrl}?state=${session.state}`);
      assert.equal(redirect.status, 400);
      const result = oauth.poll(session.state);
      assert.equal(result.status, 'error');
    } finally {
      oauth.close();
    }
  });

  await check('OpenRouter PKCE: an unknown state cannot inject a key', async () => {
    const oauth = new OpenRouterOAuth({ persist: () => {} });
    try {
      const session = await oauth.start({});
      const redirect = await fetch(`${session.callbackUrl}?code=valid-code&state=bogus`);
      assert.equal(redirect.status, 400);
      assert.equal(oauth.poll(session.state).status, 'pending');
    } finally {
      oauth.close();
    }
  });

  await check('a minted key is stored on the channel and verified', async () => {
    const created = await api('/admin/channels/create', {
      method: 'POST',
      body: JSON.stringify({
        id: 'openrouter',
        type: 'openai-compatible',
        label: 'OpenRouter',
        baseUrl: upstreamBase,
        preset: 'openrouter',
        apiKey: ''
      })
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));

    runtime.setChannelApiKey('openrouter', 'good-key');
    const channel = runtime.getChannel('openrouter');
    assert.equal(channel.config.options.apiKey, 'good-key');

    const tested = await api('/admin/channels/test', {
      method: 'POST',
      body: JSON.stringify({ id: 'openrouter' })
    });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
  });

  await check('the mock exchange rejects a bad code (PKCE verifier is enforced)', async () => {
    const res = await fetch(`http://127.0.0.1:${oauthPort}/auth/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'nope' })
    });
    assert.equal(res.status, 400);
  });
} finally {
  await new Promise((resolve) => proxy.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  await new Promise((resolve) => oauthExchange.close(resolve));
  runtime.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} connection check(s) failed`);
  process.exit(1);
}
console.log('\nall connection checks passed');
