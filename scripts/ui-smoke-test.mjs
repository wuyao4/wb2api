/**
 * Browser tests for the console (Chrome/Edge via the DevTools protocol).
 *
 * Boots the proxy with a temporary config, loads the dashboard, and drives the
 * real UI: routing, channel list, connection wizard (all three strategies),
 * device-code display, QR rendering, key verification errors, and one-click
 * start. Skips cleanly when no Chromium binary is available.
 *
 *   npm run test:ui
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const chromePath = CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!chromePath) {
  console.log('skip: no Chrome/Edge binary found (set CHROME_PATH)');
  process.exit(0);
}
if (typeof WebSocket === 'undefined') {
  console.log('skip: this Node.js has no global WebSocket (Node >= 22 required)');
  process.exit(0);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy2api-ui-'));
const configPath = path.join(tempDir, 'config.json');
const profilePath = path.join(tempDir, 'profile');
const debugPort = 9400 + Math.floor(Math.random() * 200);

/* A local upstream so the gateways can answer without hitting the internet. */
const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'demo-model', name: 'Demo Model' }] }));
    return;
  }

  if (url.pathname === '/v1/chat/completions') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({
        id: 'ui',
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: { content: 'hello from mock' }, finish_reason: null }]
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        id: 'ui',
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3 }
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
      server: { host: '127.0.0.1', port: 0, apiKeys: ['sk-test-local'], running: false },
      routing: { defaultModel: 'workbuddy/deepseek-v4.1-flash', namespace: 'auto' },
      channels: {
        workbuddy: {
          type: 'workbuddy',
          enabled: true,
          label: 'WorkBuddy',
          options: { baseUrl: 'https://www.workbuddy.ai' },
          accounts: [{ id: 'primary', label: '主账号', enabled: true, maxConcurrency: 1 }]
        },
        demo: {
          type: 'openai-compatible',
          enabled: true,
          label: 'Demo 网关',
          options: { baseUrl: upstreamBase, apiKey: 'demo-key', models: ['demo-model'] }
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
const url = `http://127.0.0.1:${proxyPort}/`;

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profilePath}`,
    'about:blank'
  ],
  { stdio: 'ignore', windowsHide: true }
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJson(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      const handlers = this.handlers.get(message.method) || [];
      for (const handler of handlers) handler(message.params);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    const list = this.handlers.get(method) || [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
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
  await waitForJson(debugPort);
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  const page = targets.find((target) => target.type === 'page');
  assert.ok(page, 'no page target');

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  const exceptions = [];
  const consoleErrors = [];

  cdp.on('Runtime.exceptionThrown', (params) => {
    exceptions.push(
      params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception'
    );
  });
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') {
      consoleErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__buddyErrors = [];
      window.addEventListener('error', (event) => window.__buddyErrors.push(String(event.message)));
      window.addEventListener('unhandledrejection', (event) => window.__buddyErrors.push('rejection: ' + event.reason));
    `
  });

  const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(8000)]);
  await sleep(1800);

  const read = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
    return result.result.value;
  };

  const goto = async (view) => {
    await read(`(() => {
      document.querySelector('.nav-item[data-view="${view}"]').click();
      return true;
    })()`);
    await sleep(220);
  };

  /* ------------------------------------------------------------- shell */

  const shell = await read(`(() => ({
    title: document.title,
    navItems: [...document.querySelectorAll('.nav-item')].map((el) => el.dataset.view),
    current: document.querySelector('.nav-item[aria-current="page"]')?.dataset.view || '',
    visibleViews: [...document.querySelectorAll('.view')].filter((el) => !el.hidden).map((el) => el.dataset.view),
    channelCount: document.getElementById('navChannelCount')?.textContent || '',
    status: document.getElementById('statusText')?.textContent || ''
  }))()`);

  await check('shell renders six routed views with overview active', async () => {
    assert.deepEqual(shell.navItems, [
      'overview',
      'channels',
      'connect',
      'accounts',
      'logs',
      'settings'
    ]);
    assert.equal(shell.current, 'overview');
    assert.deepEqual(shell.visibleViews, ['overview']);
    assert.equal(shell.channelCount, '2');
    assert.match(shell.status, /已连接|未配置|运行中/);
  });

  await check('overview shows a channel health summary', async () => {
    await goto('overview');
    const health = await read(`(() => ({
      items: document.querySelectorAll('#healthGrid .health-item').length,
      meta: document.getElementById('healthMeta')?.textContent || '',
      text: document.getElementById('healthGrid')?.innerText || ''
    }))()`);
    assert.equal(health.items, 2, health.text);
    assert.match(health.meta, /已就绪/);
    assert.match(health.text, /WorkBuddy/);
    assert.match(health.text, /Demo 网关/);
  });

  await check('navigation switches the visible view and updates the hash', async () => {    await goto('channels');
    const result = await read(`(() => ({
      visible: [...document.querySelectorAll('.view')].filter((el) => !el.hidden).map((el) => el.dataset.view),
      current: document.querySelector('.nav-item[aria-current="page"]')?.dataset.view || '',
      hash: location.hash
    }))()`);
    assert.deepEqual(result.visible, ['channels']);
    assert.equal(result.current, 'channels');
    assert.equal(result.hash, '#channels');
  });

  /* ---------------------------------------------------------- channels */

  await check('channel list renders cards with status and actions', async () => {
    const list = await read(`(() => ({
      cards: document.querySelectorAll('.channel-card').length,
      text: document.getElementById('channelList')?.innerText || '',
      buttons: [...document.querySelectorAll('.channel-card .channel-actions button')].map((b) => b.textContent)
    }))()`);
    assert.equal(list.cards, 2, list.text);
    assert.match(list.text, /WorkBuddy/);
    assert.match(list.text, /Demo 网关/);
    assert.ok(list.buttons.includes('测试'));
    assert.ok(list.buttons.includes('停用'));
  });

  await check('channel search filters the list', async () => {
    await read(`(() => {
      const input = document.getElementById('channelSearch');
      input.value = 'demo';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(200);
    const filtered = await read(`(() => ({
      cards: document.querySelectorAll('.channel-card').length,
      text: document.getElementById('channelList')?.innerText || ''
    }))()`);
    assert.equal(filtered.cards, 1, filtered.text);
    assert.match(filtered.text, /Demo 网关/);

    await read(`(() => {
      const input = document.getElementById('channelSearch');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(150);
  });

  await check('status filter chips narrow the list', async () => {
    await read(`(() => {
      document.querySelector('#channelFilters [data-filter="oauth"]').click();
      return true;
    })()`);
    await sleep(200);
    const oauthOnly = await read(`(() => ({
      cards: document.querySelectorAll('.channel-card').length,
      text: document.getElementById('channelList')?.innerText || ''
    }))()`);
    // WorkBuddy authenticates through a browser flow, so it counts as an
    // account channel; the API-key channel must be filtered out.
    assert.equal(oauthOnly.cards, 1, oauthOnly.text);
    assert.match(oauthOnly.text, /WorkBuddy/);
    assert.doesNotMatch(oauthOnly.text, /Demo 网关/);

    await read(`(() => {
      document.querySelector('#channelFilters [data-filter="pending"]').click();
      return true;
    })()`);
    await sleep(200);
    const pending = await read(`(() => ({
      cards: document.querySelectorAll('.channel-card').length,
      text: document.getElementById('channelList')?.innerText || ''
    }))()`);
    // Demo has a keyless base URL and therefore counts as configured;
    // WorkBuddy has no credentials yet.
    assert.equal(pending.cards, 1, pending.text);
    assert.match(pending.text, /WorkBuddy/);

    await read(`(() => {
      document.querySelector('#channelFilters [data-filter="all"]').click();
      return true;
    })()`);
    await sleep(200);
    const all = await read(`document.querySelectorAll('.channel-card').length`);
    assert.equal(all, 2);
  });

  await check('channel detail expands with config and accounts', async () => {
    await read(`(() => {
      document.querySelector('#channelFilters [data-filter="all"]').click();
      return true;
    })()`);
    await sleep(200);

    const before = await read(`(() => ({
      panels: [...document.querySelectorAll('.channel-detail')].filter((p) => !p.hidden).length
    }))()`);
    assert.equal(before.panels, 0, 'all details should start collapsed');

    await read(`(() => {
      const card = [...document.querySelectorAll('.channel-card')].find((c) => c.innerText.includes('WorkBuddy'));
      [...card.querySelectorAll('.channel-actions button')].find((b) => b.textContent === '详情').click();
      return true;
    })()`);
    await sleep(300);

    const detail = await read(`(() => {
      const card = [...document.querySelectorAll('.channel-card')].find((c) => c.innerText.includes('WorkBuddy'));
      const panel = card.querySelector('.channel-detail');
      return {
        open: !panel.hidden,
        text: panel.innerText,
        accountRows: panel.querySelectorAll('.account-row').length,
        expanded: card.querySelector('.channel-actions button')?.getAttribute('aria-expanded')
      };
    })()`);

    assert.equal(detail.open, true);
    assert.match(detail.text, /Base URL/);
    assert.match(detail.text, /workbuddy\.ai/);
    assert.ok(detail.accountRows >= 1, `expected accounts in detail, got ${detail.accountRows}`);

    // Collapse again.
    await read(`(() => {
      const card = [...document.querySelectorAll('.channel-card')].find((c) => c.innerText.includes('WorkBuddy'));
      [...card.querySelectorAll('.channel-actions button')].find((b) => b.textContent === '收起').click();
      return true;
    })()`);
    await sleep(200);
    const collapsed = await read(`(() => {
      const card = [...document.querySelectorAll('.channel-card')].find((c) => c.innerText.includes('WorkBuddy'));
      return card.querySelector('.channel-detail').hidden;
    })()`);
    assert.equal(collapsed, true);
  });

  /* ----------------------------------------------------------- connect */

  await check('connect view groups providers by strategy', async () => {
    await goto('connect');
    const groups = await read(`(() => ({
      titles: [...document.querySelectorAll('.connect-group-title')].map((el) => el.innerText),
      items: [...document.querySelectorAll('.connect-item')].map((el) => el.dataset.preset),
      oauthCount: document.querySelectorAll('.connect-item .is-oauth-label').length
    }))()`);
    assert.equal(groups.titles.length, 3, groups.titles.join('|'));
    assert.ok(groups.items.length >= 25, `only ${groups.items.length} providers`);
    for (const id of ['openrouter', 'cline', 'qoder', 'trae', 'raccoon', 'zcode', 'minimax-code', 'loomy', 'lobsterai']) {
      assert.ok(groups.items.includes(id), `missing ${id}`);
    }
    assert.ok(groups.items.includes('kilo'));
    assert.ok(groups.items.includes('groq'));
    assert.equal(groups.oauthCount, 11);
  });

  await check('every OAuth provider shows the one-click step, not a key form', async () => {
    for (const id of ['openrouter', 'cline', 'qoder', 'gemini-code-assist', 'trae', 'raccoon', 'zcode', 'minimax-code', 'loomy', 'lobsterai', 'codebuddy']) {
      await read(`(() => {
        document.querySelector('.connect-item[data-preset="${id}"]').click();
        return true;
      })()`);
      await sleep(90);
      const panel = await read(`(() => ({
        oauth: !document.getElementById('connectStepOauth').hidden,
        key: !document.getElementById('connectStepKey').hidden,
        keyless: !document.getElementById('connectStepKeyless').hidden,
        sms: !document.getElementById('connectSms').hidden,
        label: document.getElementById('oauthStartBtn')?.textContent || ''
      }))()`);
      assert.equal(panel.oauth, true, `${id} should show the OAuth step`);
      assert.equal(panel.key, false, `${id} must not show a key form`);
      assert.equal(panel.keyless, false, `${id} must not show the keyless step`);
      if (id === 'raccoon') assert.match(panel.label, /二维码/);
      if (id === 'loomy') {
        assert.equal(panel.sms, true, 'loomy must show the SMS form');
        assert.match(panel.label, /验证码/);
      } else {
        assert.equal(panel.sms, false, `${id} must not show the SMS form`);
      }
    }
  });

  await check('a device-code provider shows the code and an authorization link', async () => {
    await read(`(() => {
      document.querySelector('.connect-item[data-preset="cline"]').click();
      return true;
    })()`);
    await sleep(150);
    await read(`(() => {
      document.getElementById('oauthStartBtn').click();
      return true;
    })()`);
    // Cline's device endpoint is real; wait for the code.
    await sleep(4500);

    const panel = await read(`(() => ({
      deviceVisible: !document.getElementById('connectDevice').hidden,
      code: document.getElementById('connectUserCode')?.textContent || '',
      stateText: document.getElementById('oauthState')?.textContent || '',
      hasLink: Boolean(document.querySelector('#oauthState a')),
      buttonEnabled: !document.getElementById('oauthStartBtn').disabled,
      errors: window.__buddyErrors || []
    }))()`);

    assert.equal(panel.deviceVisible, true, panel.stateText);
    assert.match(panel.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/, `unexpected code ${panel.code}`);
    assert.equal(panel.hasLink, true, 'the authorization link should be offered');
    // The start button must be released so the user can switch providers.
    assert.equal(panel.buttonEnabled, true);
    assert.deepEqual(panel.errors, []);
  });

  await check('switching providers mid-authorization does not leak the old panel', async () => {
    await read(`(() => {
      document.querySelector('.connect-item[data-preset="zcode"]').click();
      return true;
    })()`);
    await sleep(400);
    const panel = await read(`(() => ({
      name: document.getElementById('connectName')?.textContent || '',
      deviceVisible: !document.getElementById('connectDevice').hidden,
      qrVisible: !document.getElementById('connectQr').hidden,
      stateHidden: document.getElementById('oauthState').hidden
    }))()`);
    assert.match(panel.name, /ZCode/);
    assert.equal(panel.deviceVisible, false);
    assert.equal(panel.qrVisible, false);
    assert.equal(panel.stateHidden, true);
  });

  await check('a QR provider renders a scannable code instead of a link', async () => {
    await read(`(() => {
      document.querySelector('.connect-item[data-preset="raccoon"]').click();
      return true;
    })()`);
    await sleep(150);
    await read(`(() => {
      document.getElementById('oauthStartBtn').click();
      return true;
    })()`);
    await sleep(3500);

    const panel = await read(`(() => ({
      qrVisible: !document.getElementById('connectQr').hidden,
      svgCount: document.querySelectorAll('#connectQrImage svg').length,
      svgBytes: (document.querySelector('#connectQrImage svg')?.outerHTML || '').length,
      deviceVisible: !document.getElementById('connectDevice').hidden,
      errors: window.__buddyErrors || []
    }))()`);

    assert.equal(panel.qrVisible, true);
    assert.equal(panel.svgCount, 1, 'exactly one QR svg should be rendered');
    assert.ok(panel.svgBytes > 500, `QR svg too small: ${panel.svgBytes}`);
    assert.equal(panel.deviceVisible, false);
    assert.deepEqual(panel.errors, []);
  });

  await check('an SMS provider validates the phone before sending', async () => {
    await read(`(() => {
      document.querySelector('.connect-item[data-preset="loomy"]').click();
      return true;
    })()`);
    await sleep(150);
    await read(`(() => {
      document.getElementById('connectPhoneInput').value = '';
      document.getElementById('oauthStartBtn').click();
      return true;
    })()`);
    await sleep(300);
    const message = await read(`document.getElementById('smsMsg')?.textContent || ''`);
    assert.match(message, /手机号/);
  });

  await check('a WorkBuddy-family provider creates the channel and starts its login', async () => {
    await read(`(() => {
      document.querySelector('.connect-item[data-preset="codebuddy"]').click();
      return true;
    })()`);
    await sleep(200);
    await read(`(() => {
      document.getElementById('oauthStartBtn').click();
      return true;
    })()`);
    // The real copilot.tencent.com auth-state endpoint is called here.
    await sleep(6000);

    const panel = await read(`(() => ({
      stateText: document.getElementById('oauthState')?.textContent || '',
      hasLink: Boolean(document.querySelector('#oauthState a')),
      buttonEnabled: !document.getElementById('oauthStartBtn').disabled,
      channelRows: [...document.querySelectorAll('.channel-card')].map((c) => c.innerText).join('|'),
      errors: window.__buddyErrors || []
    }))()`);

    assert.equal(panel.hasLink, true, panel.stateText);
    assert.match(panel.stateText, /授权/);
    assert.equal(panel.buttonEnabled, true);
    // The channel must exist now so the login had a target.
    assert.match(panel.channelRows, /CodeBuddy/);
    assert.deepEqual(panel.errors, []);
  });

  await check('a key-based provider shows the key form and official page', async () => {
    await read(`(() => {
      document.querySelector('.connect-item[data-preset="groq"]').click();
      return true;
    })()`);
    await sleep(200);
    const panel = await read(`(() => ({
      keyVisible: !document.getElementById('connectStepKey').hidden,
      oauthVisible: !document.getElementById('connectStepOauth').hidden,
      keyPageVisible: !document.getElementById('openKeyPageBtn').hidden,
      name: document.getElementById('connectName')?.textContent || '',
      autoChecked: document.getElementById('autoCaptureInput')?.checked
    }))()`);
    assert.equal(panel.keyVisible, true);
    assert.equal(panel.oauthVisible, false);
    assert.equal(panel.keyPageVisible, true);
    assert.equal(panel.autoChecked, true);
    assert.match(panel.name, /Groq/);
  });

  await check('a bad key surfaces the verification error inline', async () => {
    await read(`(() => {
      document.getElementById('connectKeyInput').value = 'definitely-not-a-real-key-000';
      document.getElementById('verifyKeyBtn').click();
      return true;
    })()`);
    await sleep(7000);
    const result = await read(`(() => ({
      text: document.getElementById('connectResult')?.textContent || '',
      isError: document.getElementById('connectResult')?.classList.contains('is-error'),
      errors: window.__buddyErrors || []
    }))()`);
    assert.equal(result.isError, true, result.text);
    assert.match(result.text, /校验失败|拒绝|Key/);
    assert.deepEqual(result.errors, []);
  });

  await check('a keyless provider adds the channel and offers one-click start', async () => {
    await read(`(() => {
      document.querySelector('.connect-item[data-preset="kilo"]').click();
      return true;
    })()`);
    await sleep(200);
    await read(`(() => {
      document.getElementById('addKeylessBtn').click();
      return true;
    })()`);
    await sleep(4000);

    const result = await read(`(() => ({
      text: document.getElementById('connectResult')?.textContent || '',
      hasStart: Boolean(document.querySelector('#connectResult .connect-start')),
      errors: window.__buddyErrors || []
    }))()`);
    assert.equal(result.hasStart, true, result.text);
    assert.match(result.text, /已添加|已连接/);
    assert.deepEqual(result.errors, []);
  });

  await check('the one-click start button runs the gateway', async () => {
    const clicked = await read(`(() => {
      const button = document.querySelector('#connectResult .connect-start');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(clicked, true, 'start button missing');

    await sleep(7000);
    const after = await read(`(() => ({
      running: document.getElementById('statusText')?.textContent || '',
      live: !document.getElementById('outputLive')?.hidden,
      errors: window.__buddyErrors || []
    }))()`);
    assert.match(after.running, /运行中/);
    assert.equal(after.live, true);
    assert.deepEqual(after.errors, []);
  });

  /* ---------------------------------------------------------- accounts */

  await check('accounts view shows the WorkBuddy credential card', async () => {
    await goto('accounts');
    const panel = await read(`(() => ({
      credVisible: !document.getElementById('cardCredentials').hidden,
      accountRows: document.querySelectorAll('.account-row').length,
      hasLoginBtn: Boolean(document.getElementById('loginBtn'))
    }))()`);
    assert.equal(panel.credVisible, true);
    assert.equal(panel.hasLoginBtn, true);
    assert.ok(panel.accountRows >= 1, `expected seeded accounts, got ${panel.accountRows}`);
  });

  /* ------------------------------------------------------------ logs */

  await check('logs view exposes result filters', async () => {
    await goto('logs');
    const panel = await read(`(() => ({
      filters: [...document.querySelectorAll('#logFilters .chip')].map((el) => el.dataset.filter),
      hasList: Boolean(document.getElementById('logList')),
      hasHeader: Boolean(document.querySelector('.log-head'))
    }))()`);
    assert.deepEqual(panel.filters, ['all', 'ok', 'error']);
    assert.equal(panel.hasList, true);
    assert.equal(panel.hasHeader, true);
  });

  await check('a real request appears in the log and the dashboard stats', async () => {
    // The demo channel points at a local mock; this exercises the whole relay
    // path (gateway → channel → upstream → log → UI).
    const response = await fetch(`${url}v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test-local' },
      body: JSON.stringify({
        model: 'demo-model',
        messages: [{ role: 'user', content: 'hi' }]
      })
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.choices[0].message.content, 'hello from mock');

    // Give the poller a moment, then force a refresh through the UI.
    await sleep(1500);
    await read(`document.getElementById('refreshAllBtn').click()`);
    await sleep(1500);

    const logs = await read(`(() => ({
      rows: document.querySelectorAll('#logList .log-row').length,
      recent: document.querySelectorAll('#recentLogList .log-row').length,
      text: document.getElementById('logList')?.innerText || '',
      requests: document.getElementById('statRequests')?.textContent || '',
      prompt: document.getElementById('statPrompt')?.textContent || ''
    }))()`);

    assert.ok(logs.rows >= 1, `expected a log row, got text: ${logs.text}`);
    assert.ok(logs.recent >= 1, 'the overview should show the request too');
    assert.match(logs.text, /demo-model/);
    assert.match(logs.text, /200/);
    assert.equal(logs.requests, '1');
    assert.equal(logs.prompt, '5');
  });

  await check('log filters narrow by result', async () => {
    await read(`(() => {
      document.querySelector('#logFilters [data-filter="error"]').click();
      return true;
    })()`);
    await sleep(300);
    const errors = await read(`document.querySelectorAll('#logList .log-row').length`);
    // The only request succeeded.
    assert.equal(errors, 0);

    await read(`(() => {
      document.querySelector('#logFilters [data-filter="ok"]').click();
      return true;
    })()`);
    await sleep(300);
    const ok = await read(`document.querySelectorAll('#logList .log-row').length`);
    assert.ok(ok >= 1);

    await read(`(() => {
      document.querySelector('#logFilters [data-filter="all"]').click();
      return true;
    })()`);
    await sleep(200);
  });

  /* -------------------------------------------------------- settings */

  await check('settings exposes routing controls and runtime info', async () => {
    await goto('settings');
    const panel = await read(`(() => ({
      namespace: document.getElementById('namespaceSelect')?.value || '',
      options: [...document.querySelectorAll('#namespaceSelect option')].map((o) => o.value),
      configPath: document.getElementById('infoConfig')?.textContent || '',
      host: document.getElementById('infoHost')?.textContent || '',
      channels: document.getElementById('infoChannels')?.textContent || '',
      exposeChecked: document.getElementById('exposeUnprefixedInput')?.checked,
      defaultModel: document.getElementById('routingDefaultInput')?.value || ''
    }))()`);
    assert.deepEqual(panel.options, ['auto', 'always', 'never']);
    assert.equal(panel.namespace, 'auto');
    assert.equal(panel.exposeChecked, false);
    assert.ok(panel.defaultModel.length > 0, 'default model should be populated');
    assert.match(panel.configPath, /config\.json$/);
    // Port 0 in the test config must be reported as the real bound port.
    assert.doesNotMatch(panel.host, /:0$/, `host shows a placeholder port: ${panel.host}`);
    assert.ok(Number(panel.channels) >= 3, `expected >=3 channels, got ${panel.channels}`);
  });

  await check('the expose-unprefixed toggle round-trips through the API', async () => {
    await read(`(() => {
      const box = document.getElementById('exposeUnprefixedInput');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('saveRoutingBtn').click();
      return true;
    })()`);
    await sleep(1200);

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(persisted.routing.exposeUnprefixed, true);

    // Reloading the page must show the persisted value, not the default.
    const loaded = await fetch(`${url}admin/status`).then((r) => r.json());
    assert.equal(loaded.globalRouting.exposeUnprefixed, true);

    await read(`(() => {
      document.getElementById('exposeUnprefixedInput').checked = false;
      document.getElementById('saveRoutingBtn').click();
      return true;
    })()`);
    await sleep(900);
  });

  await check('saving routing settings persists the namespace', async () => {
    await read(`(() => {
      const select = document.getElementById('namespaceSelect');
      select.value = 'always';
      document.getElementById('saveRoutingBtn').click();
      return true;
    })()`);
    await sleep(1200);
    const message = await read(`document.getElementById('routingMsg')?.textContent || ''`);
    assert.match(message, /已保存/);

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(persisted.routing.namespace, 'always');

    // Restore so later assertions about model ids stay predictable.
    await read(`(() => {
      const select = document.getElementById('namespaceSelect');
      select.value = 'auto';
      document.getElementById('saveRoutingBtn').click();
      return true;
    })()`);
    await sleep(900);
  });

  /* ------------------------------------------------------------ hygiene */

  await check('no runtime errors occurred during the whole session', async () => {
    const errors = await read(`window.__buddyErrors || []`);
    assert.deepEqual(errors, []);
    assert.deepEqual(exceptions, []);
    assert.deepEqual(consoleErrors, []);
  });

  cdp.close();
} finally {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    chrome.kill('SIGKILL');
  }
  await new Promise((resolve) => {
    chrome.once('exit', resolve);
    setTimeout(resolve, 2500);
  });
  // Stop OAuth polling loops and callback listeners before closing the server,
  // otherwise a pending device-code session keeps the process alive.
  runtime.close();
  await new Promise((resolve) => proxy.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may keep the profile locked briefly */
  }
}

if (failures) {
  console.error(`\n${failures} UI check(s) failed`);
  process.exit(1);
}
console.log('\nall UI checks passed');
