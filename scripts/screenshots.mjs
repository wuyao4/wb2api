/**
 * Screenshot capture for visual review.
 *
 * Boots the console with a realistic config and writes PNGs of every view so
 * the layout can be inspected. Not part of `npm test` (it needs a display-sized
 * window and produces artifacts).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find((p) => fs.existsSync(p));

if (!CHROME) {
  console.log('skip: no Chrome found');
  process.exit(0);
}

const outDir = path.resolve(process.argv[2] || 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-shot-'));
const configPath = path.join(tempDir, 'config.json');

fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      version: 2,
      server: { host: '127.0.0.1', port: 0, apiKeys: ['sk-demo-key-123456'], running: false },
      routing: { defaultModel: 'workbuddy/deepseek-v4.1-flash', namespace: 'auto' },
      channels: {
        workbuddy: {
          type: 'workbuddy',
          enabled: true,
          label: 'WorkBuddy',
          options: { baseUrl: 'https://www.workbuddy.ai' },
          accounts: [
            { id: 'primary', label: '主账号', enabled: true, maxConcurrency: 1 },
            { id: 'acc-2', label: '备用账号', enabled: true, maxConcurrency: 2 }
          ]
        },
        kilo: {
          type: 'openai-compatible',
          enabled: true,
          label: 'Kilo 免费池',
          options: { baseUrl: 'https://api.kilo.ai/api/gateway', preset: 'kilo', models: ['kilo-auto/free'] }
        },
        openrouter: {
          type: 'openai-compatible',
          enabled: false,
          label: 'OpenRouter',
          options: { baseUrl: 'https://openrouter.ai/api/v1', preset: 'openrouter', apiKey: '' }
        },
        groq: {
          type: 'openai-compatible',
          enabled: true,
          label: 'Groq',
          options: { baseUrl: 'https://api.groq.com/openai/v1', preset: 'groq', apiKey: 'gsk_demo' }
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

process.env.WB2API_CONFIG = configPath;

const { Runtime } = await import('../src/runtime.js');
const { createServer } = await import('../src/server.js');

const runtime = new Runtime();
const proxy = createServer(runtime);
const port = await new Promise((r) => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
const base = `http://127.0.0.1:${port}/`;

const debugPort = 9600 + Math.floor(Math.random() * 150);
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--window-size=1440,1000',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(tempDir, 'profile')}`,
    'about:blank'
  ],
  { stdio: 'ignore', windowsHide: true }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      if (!m.id) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

try {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (r.ok) break;
    } catch {}
    await sleep(150);
  }

  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 2,
    mobile: false
  });

  await cdp.send('Page.navigate', { url: base });
  await sleep(3000);

  const views = ['overview', 'channels', 'connect', 'accounts', 'logs', 'settings'];
  for (const view of views) {
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('.nav-item[data-view="${view}"]').click()`,
      returnByValue: true
    });
    await sleep(900);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, `${view}.png`), Buffer.from(shot.data, 'base64'));
    console.log('captured', view);
  }

  // Mobile layout
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 414,
    height: 900,
    deviceScaleFactor: 2,
    mobile: true
  });
  await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('.nav-item[data-view="connect"]').click()`,
    returnByValue: true
  });
  await sleep(900);
  const mobileShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'mobile-connect.png'), Buffer.from(mobileShot.data, 'base64'));
  console.log('captured mobile-connect');

  cdp.ws.close();
} finally {
  spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(1500);
  runtime.close();
  await new Promise((r) => proxy.close(r));
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}
