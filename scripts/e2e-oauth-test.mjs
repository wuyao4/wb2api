/**
 * End-to-end OAuth → channel → proxy test.
 *
 * Exercises the whole path the dashboard uses:
 *   oauth/start → provider approves → oauth/status writes the credential →
 *   channel appears → /v1/chat/completions answers.
 *
 * The provider's HTTP surface is mocked, but everything from the admin route
 * down (channel creation, account storage, pool rebuild, proxy relay) is real.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-e2e-oauth-'));
const configPath = path.join(tempDir, 'config.json');
const LOCAL_KEY = 'sk-e2e-test';

/* ------------------------------------------------------------- mock upstream */

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const auth = req.headers.authorization || '';

  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-model', name: 'E2E Model' }] }));
    return;
  }

  if (url.pathname === '/v1/chat/completions') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!auth.startsWith('Bearer ')) {
      res.writeHead(401).end(JSON.stringify({ error: { message: 'no token' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({
        id: 'e',
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: { content: 'authorized' }, finish_reason: null }]
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        id: 'e',
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.writeHead(404).end();
});

const upstreamPort = await new Promise((resolve) =>
  upstream.listen(0, '127.0.0.1', () => resolve(upstream.address().port))
);

/* ------------------------------------------- mock the provider's OAuth surface */

const realFetch = globalThis.fetch;
let devicePolls = 0;

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;

  if (url.startsWith('https://api.workos.com/user_management/authorize/device')) {
    return new Response(
      JSON.stringify({
        device_code: 'dev-e2e',
        user_code: 'E2E1-CODE',
        verification_uri: 'https://authkit.example/device',
        verification_uri_complete: 'https://authkit.example/device?user_code=E2E1-CODE',
        expires_in: 60,
        interval: 1
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (url.startsWith('https://api.workos.com/user_management/authenticate')) {
    devicePolls += 1;
    if (devicePolls === 1) {
      return new Response(JSON.stringify({ error: 'authorization_pending' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(
      JSON.stringify({ access_token: 'workos-e2e', refresh_token: 'refresh-e2e' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (url.startsWith('https://api.cline.bot/api/v1/auth/register')) {
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          accessToken: 'workos:cline-e2e',
          refreshToken: 'cline-refresh',
          expiresAt: Date.now() + 3600_000,
          userInfo: { clineUserId: 'u-e2e', email: 'e2e@example.com', name: 'E2E User' }
        }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return realFetch(input, init);
};

/* ------------------------------------------------------------------ config */

fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      version: 2,
      server: { host: '127.0.0.1', port: 0, apiKeys: [LOCAL_KEY], running: false },
      routing: { defaultModel: '', namespace: 'auto' },
      channels: {},
      prompt: { system: 'x', injectWhenMissing: true },
      retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 20 },
      logging: { requests: false }
    },
    null,
    2
  )
);

process.env.WB2API_CONFIG = configPath;

const { Runtime } = await import('../src/runtime.js');
const { createServer } = await import('../src/server.js');

const runtime = new Runtime();
const proxy = createServer(runtime);
const proxyPort = await new Promise((resolve) =>
  proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port))
);
const base = `http://127.0.0.1:${proxyPort}`;

async function api(pathname, options = {}) {
  const res = await realFetch(`${base}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

try {
  let state = '';

  await check('oauth/start issues a device code for Cline', async () => {
    const { status, body } = await api('/admin/connect/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ provider: 'cline', channelId: 'cline' })
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.mode, 'device-code');
    assert.equal(body.userCode, 'E2E1-CODE');
    state = body.state;
    assert.ok(state);
  });

  await check('oauth/status stays pending until the user approves', async () => {
    const { status, body } = await api(
      `/admin/connect/oauth/status?provider=cline&state=${encodeURIComponent(state)}`
    );
    assert.equal(status, 200);
    assert.ok(['pending', 'exchanging', 'success'].includes(body.status), body.status);
  });

  await check('approval writes the credential and creates the channel', async () => {
    let result = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const { body } = await api(
        `/admin/connect/oauth/status?provider=cline&state=${encodeURIComponent(state)}`
      );
      if (body.status === 'success') {
        result = body;
        break;
      }
      if (body.status === 'error') throw new Error(body.error);
      await sleep(250);
    }
    assert.ok(result, 'authorization never completed');
    assert.equal(result.channel, 'cline');

    const channel = runtime.getChannel('cline');
    assert.ok(channel, 'channel was not created');
    assert.equal(channel.type, 'account');
    const entry = channel.config.accounts.find((account) => account.id === 'primary');
    assert.ok(entry, 'account was not stored');
    assert.equal(entry.accessToken, 'workos:cline-e2e');
    assert.equal(entry.email, 'e2e@example.com');
  });

  await check('the stored credential is masked in the admin API', async () => {
    const { body } = await api('/admin/status');
    assert.ok(!JSON.stringify(body).includes('cline-e2e'), 'token leaked in /admin/status');
    const cline = body.channels.find((channel) => channel.id === 'cline');
    assert.equal(cline.configured, true);
  });

  await check('the new channel can start the proxy and answer a request', async () => {
    // Point the channel at the mock upstream so the relay path is exercised.
    runtime.updateChannel('cline', { options: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } });

    const started = await api('/admin/start', {
      method: 'POST',
      body: JSON.stringify({ apiKey: LOCAL_KEY, defaultModel: 'cline/e2e-model' })
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    const res = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LOCAL_KEY}` },
      body: JSON.stringify({
        model: 'cline/e2e-model',
        messages: [{ role: 'user', content: 'hi' }]
      })
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.choices[0].message.content, 'authorized');
  });

  await check('the credential survives a config reload', async () => {
    runtime.reload();
    const channel = runtime.getChannel('cline');
    const entry = channel.config.accounts.find((account) => account.id === 'primary');
    assert.equal(entry.accessToken, 'workos:cline-e2e');
  });
} finally {
  globalThis.fetch = realFetch;
  runtime.close();
  await new Promise((resolve) => proxy.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} end-to-end OAuth check(s) failed`);
  process.exit(1);
}
console.log('\nall end-to-end OAuth checks passed');
