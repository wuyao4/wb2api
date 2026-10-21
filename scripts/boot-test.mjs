/**
 * Cold-start check: run the real entrypoint (`src/index.js`) with a temporary
 * config, then verify the dashboard, admin API and a live chat round-trip.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-boot-'));
const configPath = path.join(tempDir, 'config.json');
const port = 8900 + Math.floor(Math.random() * 80);

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'boot-model' }] }));
    return;
  }
  if (url.pathname === '/v1/chat/completions') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({
        id: 'b',
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: { content: 'boot ok' }, finish_reason: null }]
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        id: 'b',
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 2 }
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(404).end();
});

const upstreamPort = await new Promise((r) =>
  upstream.listen(0, '127.0.0.1', () => r(upstream.address().port))
);

fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      version: 2,
      server: { host: '127.0.0.1', port, apiKeys: ['sk-boot-test'], running: false },
      routing: { defaultModel: 'boot/boot-model', namespace: 'auto' },
      channels: {
        boot: {
          type: 'openai-compatible',
          enabled: true,
          label: 'Boot',
          options: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'k', models: ['boot-model'] }
        }
      },
      prompt: { system: 'x', injectWhenMissing: true },
      retry: { maxAttempts: 1 },
      logging: { requests: false }
    },
    null,
    2
  )
);

const child = spawn(process.execPath, ['src/index.js'], {
  env: { ...process.env, WB2API_CONFIG: configPath },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
child.stdout.on('data', (d) => {
  output += d;
});
child.stderr.on('data', (d) => {
  output += d;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
};

try {
  let up = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* not yet */
    }
    await sleep(200);
  }

  await check('entrypoint boots and reports its real port', async () => {
    if (!up) throw new Error(`server did not start:\n${output}`);
    const status = await fetch(`http://127.0.0.1:${port}/admin/status`).then((r) => r.json());
    if (status.config.port !== port) {
      throw new Error(`expected port ${port}, got ${status.config.port}`);
    }
  });

  await check('dashboard HTML is served', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const html = await res.text();
    if (!res.ok || !html.includes('Buddy')) throw new Error('dashboard missing');
    if (!html.includes('data-view="connect"')) throw new Error('new shell missing');
  });

  await check('gateway starts and answers a completion', async () => {
    const started = await fetch(`http://127.0.0.1:${port}/admin/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-boot-test' })
    }).then((r) => r.json());
    if (!started.ok) throw new Error(JSON.stringify(started));

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-boot-test' },
      body: JSON.stringify({ model: 'boot/boot-model', messages: [{ role: 'user', content: 'hi' }] })
    });
    const body = await res.json();
    if (body.choices?.[0]?.message?.content !== 'boot ok') throw new Error(JSON.stringify(body));
  });

  await check('shutdown closes OAuth listeners and exits cleanly', async () => {
    const code = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), 6000));
    const result = await Promise.race([code, timer]);
    if (result === 'timeout') throw new Error('process did not exit');
  });
} finally {
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  await new Promise((r) => upstream.close(r));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} boot check(s) failed`);
  process.exit(1);
}
console.log('\nall boot checks passed');
