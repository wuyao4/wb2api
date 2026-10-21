/**
 * Account-channel runtime tests.
 *
 * The OAuth channels (Cline / Qoder / Gemini / TRAE / Raccoon) share one
 * runtime, so its behaviour is verified once against a mock upstream:
 * token transport, model discovery, validation, account management and the
 * "no credential yet" state.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-account-'));
const configPath = path.join(tempDir, 'config.json');
const LOCAL_KEY = 'sk-acct-test';

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const auth = req.headers.authorization || '';

  if (url.pathname === '/v1/models') {
    if (auth !== 'Bearer account-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'account-model', name: 'Account Model', context_length: 128000 },
          { id: 'second-model', name: 'Second Model' }
        ]
      })
    );
    return;
  }

  if (url.pathname === '/v1/chat/completions') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    if (auth !== 'Bearer account-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({
        id: 'x',
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: { content: `acct:${body.model}` }, finish_reason: null }]
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        id: 'x',
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 }
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
const upstreamBase = `http://127.0.0.1:${upstreamPort}/v1`;

fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      version: 2,
      server: { host: '127.0.0.1', port: 0, apiKeys: [LOCAL_KEY], running: false },
      routing: { defaultModel: 'cline/account-model', namespace: 'auto' },
      channels: {
        cline: {
          type: 'account',
          enabled: true,
          label: 'Cline',
          oauth: 'cline',
          options: { baseUrl: upstreamBase },
          models: { allowUnknown: true, contextWindow: { default: 0, overrides: {} } },
          routing: { sessionAffinity: false, failover: true },
          accounts: [
            {
              id: 'primary',
              label: 'tester@example.com',
              enabled: true,
              maxConcurrency: 2,
              accessToken: 'account-token',
              refreshToken: 'refresh',
              email: 'tester@example.com'
            }
          ]
        },
        empty: {
          type: 'account',
          enabled: false,
          label: 'Unauthorized',
          oauth: 'qoder',
          options: { baseUrl: upstreamBase },
          accounts: []
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

const { Runtime } = await import('../src/runtime.js');
const { createServer } = await import('../src/server.js');

const runtime = new Runtime();
const proxy = createServer(runtime);
const proxyPort = await new Promise((resolve) =>
  proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port))
);
const base = `http://127.0.0.1:${proxyPort}`;

async function api(pathname, options = {}) {
  const res = await fetch(`${base}${pathname}`, {
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
  await check('an authorized account channel reports itself as configured', async () => {
    const channel = runtime.getChannel('cline');
    assert.equal(channel.type, 'account');
    const status = channel.status();
    assert.equal(status.configured, true);
    assert.equal(status.accountCount, 1);
    assert.equal(status.accounts[0].email, 'tester@example.com');
    assert.ok(!JSON.stringify(status).includes('account-token'), 'token must be masked');
  });

  await check('a channel with no credential reports zero accounts', async () => {
    const channel = runtime.getChannel('empty');
    const status = channel.status();
    assert.equal(status.configured, false);
    assert.equal(status.accountCount, 0);
  });

  await check('validate refuses a channel without a credential', async () => {
    const result = await runtime.getChannel('empty').validate();
    assert.equal(result.ok, false);
    // Match on the channel label, not on a Chinese substring: the Windows
    // console encoding can mangle non-ASCII text in captured output.
    assert.ok(result.error && result.error.includes('Unauthorized'), result.error);
  });

  await check('validate accepts a channel that has a token', async () => {
    const result = await runtime.getChannel('cline').validate();
    assert.equal(result.ok, true);
  });

  await check('models are discovered from the configured base URL', async () => {
    const models = await runtime.getChannel('cline').listModels();
    const ids = models.map((model) => model.id);
    assert.ok(ids.includes('account-model'), ids.join(','));
    assert.ok(ids.includes('second-model'));
  });

  await check('the token is sent as a bearer credential', async () => {
    const channel = runtime.getChannel('cline');
    const slot = await channel.chat({
      body: { model: 'account-model', messages: [{ role: 'user', content: 'hi' }] },
      options: {}
    });
    assert.equal(slot.res.status, 200);
    await slot.res.text();
    slot.release();
  });

  await check('an account channel answers a chat completion through the proxy', async () => {
    const started = await api('/admin/start', {
      method: 'POST',
      body: JSON.stringify({ apiKey: LOCAL_KEY, defaultModel: 'cline/account-model' })
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LOCAL_KEY}` },
      body: JSON.stringify({
        model: 'cline/account-model',
        messages: [{ role: 'user', content: 'hi' }]
      })
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.choices[0].message.content, 'acct:account-model');
  });

  await check('account management works on an account channel', async () => {
    const toggled = await api('/admin/accounts/toggle', {
      method: 'POST',
      body: JSON.stringify({ channel: 'cline', id: 'primary', enabled: false })
    });
    assert.equal(toggled.status, 200, JSON.stringify(toggled.body));
    assert.equal(toggled.body.accounts[0].enabled, false);

    await api('/admin/accounts/toggle', {
      method: 'POST',
      body: JSON.stringify({ channel: 'cline', id: 'primary', enabled: true })
    });
  });

  await check('the primary account cannot be removed', async () => {
    const res = await api('/admin/accounts/remove', {
      method: 'POST',
      body: JSON.stringify({ channel: 'cline', id: 'primary' })
    });
    assert.equal(res.status, 400);
  });

  await check('describing an account channel never leaks the token', async () => {
    const { status, body } = await api('/admin/channels');
    assert.equal(status, 200);
    const cline = body.channels.find((entry) => entry.id === 'cline');
    assert.equal(cline.options.hasToken, true);
    assert.ok(!JSON.stringify(body).includes('account-token'), 'token leaked in channel list');
  });
} finally {
  runtime.close();
  await new Promise((resolve) => proxy.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} account channel check(s) failed`);
  process.exit(1);
}
console.log('\nall account channel checks passed');
