/**
 * End-to-end smoke test for the multi-channel gateway.
 *
 * Starts a mock OpenAI-compatible upstream, boots the proxy with a temporary
 * config, then exercises the admin API plus the OpenAI and Anthropic endpoints.
 * Zero dependencies; run with `npm test`.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-test-'));
const configPath = path.join(tempDir, 'config.json');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

let lastChatRequest = null;

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'mock-model', name: 'Mock Model', context_length: 32000 },
          { id: 'other-model', name: 'Other Model', context_length: 16000 }
        ]
      })
    );
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    lastChatRequest = { body, authorization: req.headers.authorization || '' };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    const chunk = (delta, extra = {}) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: null }],
        ...extra
      })}\n\n`;

    res.write(chunk({ role: 'assistant', content: `echo:${body.model}` }));
    res.write(chunk({ content: ' ok' }));
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

const upstreamPort = await listen(upstream);
const upstreamBase = `http://127.0.0.1:${upstreamPort}/v1`;

fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      version: 2,
      server: {
        host: '127.0.0.1',
        port: 0,
        apiKeys: ['sk-test-local'],
        adminToken: '',
        running: false,
        requestBodyLimitMb: 16
      },
      routing: {
        defaultModel: 'mock/mock-model',
        aliases: { 'my-alias': 'mock-model' },
        namespace: 'auto',
        exposeUnprefixed: false
      },
      channels: {
        mock: {
          type: 'openai-compatible',
          enabled: true,
          label: 'Mock',
          options: {
            baseUrl: upstreamBase,
            apiKey: 'upstream-key',
            models: ['mock-model'],
            includeUsage: true,
            headerTimeoutMs: 10000
          },
          models: { aliases: {}, allowUnknown: true, contextWindow: { default: 32000, overrides: {} } },
          routing: { sessionAffinity: false, failover: true }
        }
      },
      prompt: { system: 'You are a helpful assistant.', injectWhenMissing: true },
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50 },
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
const proxyPort = await listen(proxy);
const base = `http://127.0.0.1:${proxyPort}`;
const apiKey = 'sk-test-12345678';

async function api(pathname, options = {}, key = '') {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(`${base}${pathname}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text, headers: response.headers };
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
  await check('legacy single-channel config migrates to channels.workbuddy', async () => {
    const legacyPath = path.join(tempDir, 'legacy.json');
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        upstream: {
          baseUrl: 'https://www.workbuddy.ai',
          accessToken: 'legacy-access',
          refreshToken: 'legacy-refresh',
          maxConcurrency: 2,
          label: '旧主账号'
        },
        accounts: [{ id: 'extra', label: '旧备用', accessToken: 'extra-access', maxConcurrency: 3 }],
        models: { default: 'kimi-k3' },
        routing: { sessionAffinity: false },
        prompt: { system: 'legacy prompt' }
      })
    );
    const { loadConfig } = await import('../src/core/config.js');
    const legacy = loadConfig(legacyPath);
    assert.equal(legacy.version, 2);
    assert.equal(legacy.routing.defaultModel, 'workbuddy/kimi-k3');
    assert.equal(legacy.routing.sessionAffinity, undefined);
    const channel = legacy.channels.workbuddy;
    assert.equal(channel.accounts.length, 2);
    assert.equal(channel.accounts[0].label, '旧主账号');
    assert.equal(channel.accounts[0].maxConcurrency, 2);
    assert.equal(channel.routing.sessionAffinity, false);
    assert.equal(legacy.prompt.system, 'legacy prompt');
  });

  await check('healthz reports the configured channel', async () => {
    const { status, body } = await api('/healthz');
    assert.equal(status, 200);
    assert.equal(body.channels[0].id, 'mock');
  });

  await check('admin status exposes single-channel default without namespace', async () => {
    const { status, body } = await api('/admin/status');
    assert.equal(status, 200);
    assert.equal(body.channels.length, 1);
    assert.equal(body.defaultModel, 'mock-model');
    assert.equal(body.channels[0].configured, true);
  });

  await check('admin models lists the upstream models', async () => {
    const { status, body } = await api('/admin/models');
    assert.equal(status, 200);
    const ids = body.data.map((model) => model.id);
    assert.ok(ids.includes('mock-model'), `missing mock-model in ${ids.join(',')}`);
    assert.ok(ids.includes('my-alias'), 'global alias missing');
  });

  await check('channel test endpoint validates the upstream', async () => {
    const { status, body } = await api('/admin/channels/test', {
      method: 'POST',
      body: JSON.stringify({ id: 'mock' })
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.modelCount, 2);
  });

  await check('a preset that needs a key is rejected before any request', async () => {
    const created = await api('/admin/channels/create', {
      method: 'POST',
      body: JSON.stringify({
        id: 'keyed',
        type: 'openai-compatible',
        label: 'Keyed',
        baseUrl: upstreamBase,
        preset: 'openrouter'
      })
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));

    const tested = await api('/admin/channels/test', {
      method: 'POST',
      body: JSON.stringify({ id: 'keyed' })
    });
    assert.equal(tested.status, 400);
    assert.match(tested.body.error, /API Key/);

    const removed = await api('/admin/channels/remove', {
      method: 'POST',
      body: JSON.stringify({ id: 'keyed' })
    });
    assert.equal(removed.status, 200);
  });

  await check('proxy starts with the mock channel', async () => {
    const { status, body } = await api('/admin/start', {
      method: 'POST',
      body: JSON.stringify({ apiKey, defaultModel: 'mock-model' })
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.running, true);
    assert.equal(body.defaultModel, 'mock-model');
    assert.equal(body.channel, 'mock');
  });

  await check('OpenAI streaming chat relays SSE and usage', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true
      })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /event-stream/);
    const text = await response.text();
    assert.match(text, /echo:mock-model/);
    assert.match(text, /"prompt_tokens":7/);
    assert.match(text, /\[DONE\]/);
    assert.equal(lastChatRequest.authorization, 'Bearer upstream-key');
    assert.equal(lastChatRequest.body.stream, true);
    assert.equal(lastChatRequest.body.messages[0].content, 'hi');
  });

  await check('OpenAI non-streaming chat aggregates the stream', async () => {
    const { status, body } = await api(
      '/v1/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'my-alias',
          messages: [{ role: 'user', content: 'hi' }]
        })
      },
      apiKey
    );
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'echo:mock-model ok');
    assert.equal(body.usage.total_tokens, 10);
  });

  await check('Anthropic messages endpoint converts in both directions', async () => {
    const { status, body } = await api(
      '/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'mock-model',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hi' }]
        })
      },
      apiKey
    );
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.type, 'message');
    assert.equal(body.content[0].text, 'echo:mock-model ok');
    assert.equal(body.usage.output_tokens, 3);
  });

  await check('adding a second channel switches /v1/models to namespaced ids', async () => {
    const created = await api('/admin/channels/create', {
      method: 'POST',
      body: JSON.stringify({
        id: 'mock2',
        type: 'openai-compatible',
        label: 'Mock 2',
        baseUrl: upstreamBase,
        models: ['other-model']
      })
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));

    const status = await api('/admin/status');
    assert.equal(status.body.channels.length, 2);
    assert.equal(status.body.defaultModel, 'mock/mock-model');

    const models = await api('/admin/models');
    const ids = models.body.data.map((model) => model.id);
    assert.ok(ids.includes('mock/mock-model'), `missing namespaced id: ${ids.join(',')}`);
    assert.ok(ids.includes('mock2/other-model'), `missing second channel id: ${ids.join(',')}`);

    const removed = await api('/admin/channels/remove', {
      method: 'POST',
      body: JSON.stringify({ id: 'mock2' })
    });
    assert.equal(removed.status, 200);
  });

  await check('unknown API key is rejected', async () => {
    const response = await fetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(response.status, 401);
  });
} finally {
  await new Promise((resolve) => proxy.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall smoke checks passed');
