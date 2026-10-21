/**
 * OAuth provider tests.
 *
 * Each provider's HTTP surface is mocked locally so the full handshake runs
 * offline: device-code polling state machine (including `authorization_pending`
 * and `slow_down`), loopback callbacks, PKCE exchange, one-shot credential
 * delivery and state isolation.
 *
 * The provider modules read their endpoints from module constants, so the tests
 * intercept `fetch` instead of rewriting URLs. That keeps the production code
 * free of test-only branches.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { OAuthRegistry } from '../src/channels/oauth/index.js';

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

/* ------------------------------------------------------- fetch interception */

const realFetch = globalThis.fetch;
const routes = new Map();

function route(match, handler) {
  routes.set(match, handler);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  for (const [match, handler] of routes) {
    if (typeof match === 'string' ? url.startsWith(match) : match.test(url)) {
      return handler(url, init);
    }
  }
  throw new Error(`unmocked request: ${url}`);
};

/* ---------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 5000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error('timed out waiting for condition');
}

const registry = new OAuthRegistry({ persist: () => {} });

try {
  /* ------------------------------------------------------------------ cline */

  let clinePolls = 0;
  route('https://api.workos.com/user_management/authorize/device', () =>
    json({
      device_code: 'device-abc',
      user_code: 'TEST-CODE',
      verification_uri: 'https://authkit.example/device',
      verification_uri_complete: 'https://authkit.example/device?user_code=TEST-CODE',
      expires_in: 60,
      interval: 1
    })
  );
  route('https://api.workos.com/user_management/authenticate', () => {
    clinePolls += 1;
    if (clinePolls === 1) {
      // The real service answers 400 with this body; it is NOT a failure.
      return json(
        { error: 'authorization_pending', error_description: 'still pending' },
        400
      );
    }
    if (clinePolls === 2) {
      return json({ error: 'slow_down' }, 400);
    }
    return json({ access_token: 'workos-token', refresh_token: 'refresh-1', token_type: 'Bearer' });
  });
  route('https://api.cline.bot/api/v1/auth/register', () =>
    json({
      success: true,
      data: {
        accessToken: 'workos:cline-token',
        refreshToken: 'cline-refresh',
        expiresAt: Date.now() + 3600_000,
        userInfo: { clineUserId: 'u1', email: 'a@example.com', name: 'Tester' }
      }
    })
  );

  await check('cline: device code flow tolerates pending and slow_down', async () => {
    const started = await registry.start('cline', { channelId: 'cline' });
    assert.equal(started.mode, 'device-code');
    assert.equal(started.userCode, 'TEST-CODE');
    assert.match(started.authUrl, /user_code=TEST-CODE/);

    const done = await waitFor(() => {
      const polled = registry.poll('cline', started.state);
      if (polled.status === 'error') throw new Error(polled.error);
      return polled.status === 'success' ? polled : null;
    }, { timeout: 15000 });

    assert.equal(done.credential.accessToken, 'workos:cline-token');
    assert.equal(done.credential.email, 'a@example.com');
    assert.ok(done.credential.expiresAt > Date.now());
    assert.ok(clinePolls >= 3, `expected 3 polls, got ${clinePolls}`);
  });

  await check('cline: the token prefix is preserved (stripping it breaks auth)', async () => {
    const started = await registry.start('cline', { channelId: 'cline' });
    const done = await waitFor(() => {
      const polled = registry.poll('cline', started.state);
      return polled.status === 'success' ? polled : null;
    }, { timeout: 15000 });
    assert.ok(
      done.credential.accessToken.startsWith('workos:'),
      'the workos: prefix must be kept'
    );
  });

  await check('cline: a credential is delivered exactly once', async () => {
    const started = await registry.start('cline', { channelId: 'cline' });
    await waitFor(() => registry.poll('cline', started.state).status === 'success', { timeout: 15000 });
    assert.throws(() => registry.poll('cline', started.state), /不存在或已过期/);
  });

  /* ------------------------------------------------------------------ qoder */

  let qoderPolls = 0;
  route('https://openapi.qoder.sh/api/v1/deviceToken/poll', () => {
    qoderPolls += 1;
    // 404 means "user has not approved yet" (verified against the live host).
    if (qoderPolls < 3) return json({ errorCode: 'NotFound' }, 404);
    return json({
      access_token: 'qoder-token',
      refresh_token: 'qoder-refresh',
      expire_time: Math.floor((Date.now() + 3600_000) / 1000),
      user_id: 'qoder-user',
      user_name: 'Qoder Tester'
    });
  });

  await check('qoder: 404 is treated as pending, not as an error', async () => {
    const started = await registry.start('qoder', { channelId: 'qoder' });
    assert.equal(started.mode, 'device-code');
    assert.match(started.authUrl, /challenge_method=S256/);
    assert.match(started.authUrl, /machine_id=/);

    const done = await waitFor(() => {
      const polled = registry.poll('qoder', started.state);
      if (polled.status === 'error') throw new Error(polled.error);
      return polled.status === 'success' ? polled : null;
    }, { timeout: 15000 });

    assert.equal(done.credential.accessToken, 'qoder-token');
    assert.equal(done.credential.nickname, 'Qoder Tester');
    assert.ok(done.credential.machineId, 'machine id must be persisted');
    assert.ok(qoderPolls >= 3, `expected 3 polls, got ${qoderPolls}`);
  });

  await check('qoder: the auth url carries a PKCE challenge, never the verifier', async () => {
    const started = await registry.start('qoder', { channelId: 'qoder' });
    assert.ok(!started.authUrl.includes('verifier'), 'verifier must not leak into the URL');
    assert.ok(started.authUrl.includes('challenge='));
  });

  /* ----------------------------------------------------------------- gemini */

  route('https://oauth2.googleapis.com/token', async (url, init) => {
    const body = new URLSearchParams(String(init.body || ''));
    if (body.get('grant_type') !== 'authorization_code') {
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    if (!body.get('code_verifier')) return json({ error: 'missing_verifier' }, 400);
    return json({
      access_token: 'google-token',
      refresh_token: 'google-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'cloud-platform'
    });
  });
  route('https://www.googleapis.com/oauth2/v2/userinfo', () =>
    json({ email: 'gemini@example.com', name: 'Gemini Tester' })
  );

  await check('gemini: loopback callback completes the PKCE exchange', async () => {
    const started = await registry.start('gemini-code-assist', { channelId: 'gemini-code-assist' });
    assert.equal(started.mode, 'loopback');
    assert.match(started.authUrl, /code_challenge_method=S256/);
    assert.match(started.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);

    const callback = await realFetch(
      `${started.redirectUri}?code=good-code&state=${started.state}`
    );
    assert.equal(callback.status, 200);
    assert.match(await callback.text(), /授权成功/);

    const done = registry.poll('gemini-code-assist', started.state);
    assert.equal(done.status, 'success');
    assert.equal(done.credential.accessToken, 'google-token');
    assert.equal(done.credential.email, 'gemini@example.com');
  });

  await check('gemini: an unknown state cannot inject a token', async () => {
    const started = await registry.start('gemini-code-assist', {});
    const callback = await realFetch(`${started.redirectUri}?code=evil&state=bogus`);
    assert.equal(callback.status, 400);
    assert.equal(registry.poll('gemini-code-assist', started.state).status, 'pending');
  });

  await check('gemini: a denied authorization surfaces an error', async () => {
    const started = await registry.start('gemini-code-assist', {});
    const callback = await realFetch(`${started.redirectUri}?error=access_denied&state=${started.state}`);
    assert.equal(callback.status, 400);
    const polled = registry.poll('gemini-code-assist', started.state);
    assert.equal(polled.status, 'error');
    assert.match(polled.error, /拒绝/);
  });

  /* ------------------------------------------------------------------- trae */

  route('https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken', () =>
    json({ data: { accessToken: 'trae-token', refreshToken: 'trae-refresh' } })
  );
  route('https://api.trae.com.cn/cloudide/api/v3/trae/GetUserInfo', () =>
    json({ data: { userId: 'trae-user', email: 'trae@example.com', name: 'TRAE Tester' } })
  );

  await check('trae: loopback callback exchanges the code and reads the profile', async () => {
    const started = await registry.start('trae', { channelId: 'trae' });
    assert.equal(started.mode, 'loopback');
    assert.match(started.redirectUri, /\/authorize$/);

    const callback = await realFetch(`${started.redirectUri}?code=trae-code&state=${started.state}`);
    assert.equal(callback.status, 200);

    const done = registry.poll('trae', started.state);
    assert.equal(done.status, 'success');
    assert.equal(done.credential.accessToken, 'trae-token');
    assert.equal(done.credential.email, 'trae@example.com');
  });

  /* ---------------------------------------------------------------- raccoon */

  let raccoonPolls = 0;
  route('https://xiaohuanxiong.com/api/web/auth/v1/login_with_qrcode_code', () => {
    raccoonPolls += 1;
    if (raccoonPolls < 2) return json({ code: 0, message: 'success', data: { status: 'pending' } });
    if (raccoonPolls === 2) return json({ code: 0, message: 'success', data: { status: 'logging' } });
    return json({
      code: 0,
      message: 'success',
      data: { status: 'success', access_token: 'raccoon-token', refresh_token: 'raccoon-refresh' }
    });
  });

  await check('raccoon: QR login polls to success without a redirect', async () => {
    const started = await registry.start('raccoon', { channelId: 'raccoon' });
    assert.equal(started.mode, 'qr');
    assert.match(started.qrCode, /^[0-9a-f]{32}$/);
    assert.ok(started.qrPayload.includes(started.qrCode), 'QR payload must embed the code');
    assert.equal(started.authUrl, '', 'no external auth page for the QR flow');

    const done = await waitFor(() => {
      const polled = registry.poll('raccoon', started.state);
      if (polled.status === 'error') throw new Error(polled.error);
      return polled.status === 'success' ? polled : null;
    }, { timeout: 20000 });

    assert.equal(done.credential.accessToken, 'raccoon-token');
    assert.ok(raccoonPolls >= 3);
  });

  await check('raccoon: pending polls keep returning the QR payload', async () => {
    const started = await registry.start('raccoon', {});
    const first = registry.poll('raccoon', started.state);
    assert.equal(first.status, 'pending');
    assert.equal(first.qrCode, started.qrCode);
    assert.ok(first.qrPayload.includes(started.qrCode));
  });

  /* ---------------------------------------------------------------- zcode */

  let zcodePolls = 0;
  route('https://zcode.z.ai/api/v1/oauth/cli/init', () =>
    json({
      code: 0,
      msg: '',
      data: {
        flow_id: 'flow-e2e',
        poll_token: 'poll-token',
        authorize_url: 'https://bigmodel.cn/login?appId=zcode&state=abc',
        expires_at: Math.floor(Date.now() / 1000) + 600,
        poll_interval_sec: 1
      }
    })
  );
  route('https://zcode.z.ai/api/v1/oauth/cli/poll/', () => {
    zcodePolls += 1;
    if (zcodePolls < 2) return json({ code: 0, data: { status: 'pending' } });
    return json({
      code: 0,
      data: {
        status: 'ready',
        token: 'zcode-jwt',
        user: { id: 'zcode-user', name: 'ZCode Tester' },
        bigmodel: { access_token: 'bigmodel-token', refresh_token: 'bigmodel-refresh' }
      }
    });
  });

  await check('zcode: server-mediated device flow reaches ready', async () => {
    const started = await registry.start('zcode', { channelId: 'zcode' });
    assert.equal(started.mode, 'device-code');
    assert.match(started.authUrl, /bigmodel\.cn/);

    const done = await waitFor(() => {
      const polled = registry.poll('zcode', started.state);
      if (polled.status === 'error') throw new Error(polled.error);
      return polled.status === 'success' ? polled : null;
    }, { timeout: 20000 });

    assert.equal(done.credential.accessToken, 'zcode-jwt');
    assert.equal(done.credential.providerToken, 'bigmodel-token');
    assert.equal(done.credential.provider, 'bigmodel');
    // ZCode credentials are static JWTs and cannot be refreshed.
    assert.equal(done.credential.expiresAt, 0);
  });

  /* --------------------------------------------------------- minimax-code */

  let minimaxPolls = 0;
  route('https://account.minimax.cn/oauth2/device/code', () =>
    json({
      device_code: 'mm-device',
      user_code: 'MM1-CODE',
      verification_uri: 'https://account.minimax.cn/oauth-authorize',
      verification_uri_complete: 'https://account.minimax.cn/oauth-authorize?user_code=MM1-CODE',
      expires_in: 60,
      interval: 1
    })
  );
  route('https://account.minimax.cn/oauth2/token', () => {
    minimaxPolls += 1;
    // Non-standard shape: 200 + status=pending.
    if (minimaxPolls === 1) return json({ status: 'pending' });
    return json({
      access_token: 'mmoat_token',
      refresh_token: 'mm-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'agent.default'
    });
  });

  await check('minimax: 200 + status=pending is treated as pending, not failure', async () => {
    const started = await registry.start('minimax-code', { channelId: 'minimax-code' });
    assert.equal(started.userCode, 'MM1-CODE');
    assert.match(started.authUrl, /user_code=MM1-CODE/);

    const done = await waitFor(() => {
      const polled = registry.poll('minimax-code', started.state);
      if (polled.status === 'error') throw new Error(polled.error);
      return polled.status === 'success' ? polled : null;
    }, { timeout: 20000 });

    assert.equal(done.credential.accessToken, 'mmoat_token');
    assert.ok(done.credential.expiresAt > Date.now());
    assert.equal(minimaxPolls, 2);
  });

  /* ---------------------------------------------------------------- loomy */

  route('https://account.xfinfr.com/login/phone/sendMsgCode', () =>
    json({ code: '000000', message: 'ok', data: { msgid: 'msg-1' } })
  );
  route('https://account.xfinfr.com/login/phone/checkCode', () =>
    json({ code: '000000', message: 'ok', data: { session: 'loomy-session', userid: 'loomy-user' } })
  );

  await check('loomy: SMS start issues a state and hides the phone number', async () => {
    const started = await registry.start('loomy', { channelId: 'loomy', phone: '13800138000' });
    assert.equal(started.mode, 'sms');
    assert.equal(started.phone, '13800138000');
    assert.ok(started.state);
    assert.equal(registry.poll('loomy', started.state).status, 'pending');
  });

  await check('loomy: submitting the code completes the login', async () => {
    const started = await registry.start('loomy', { channelId: 'loomy', phone: '13800138000' });
    const submitted = await registry.submit('loomy', started.state, '123456');
    assert.equal(submitted.status, 'success');

    const done = registry.poll('loomy', started.state);
    assert.equal(done.status, 'success');
    assert.equal(done.credential.accessToken, 'loomy-session');
    // The account label must not expose the full phone number.
    assert.ok(!done.account.label.includes('13800138000'), done.account.label);
    assert.match(done.account.label, /^138\*{4}8000$/);
  });

  await check('loomy: a bad code leaves the session usable for a retry', async () => {
    const started = await registry.start('loomy', { channelId: 'loomy', phone: '13800138000' });
    route('https://account.xfinfr.com/login/phone/checkCode', () =>
      json({ code: '100001', message: 'code invalid', data: null })
    );
    await assert.rejects(() => registry.submit('loomy', started.state, '000000'));
    // Still pending, so the user can try again.
    assert.equal(registry.poll('loomy', started.state).status, 'pending');

    route('https://account.xfinfr.com/login/phone/checkCode', () =>
      json({ code: '000000', message: 'ok', data: { session: 'loomy-session', userid: 'loomy-user' } })
    );
  });

  /* ------------------------------------------------------------ lobsterai */

  route('https://lobsterai-server.youdao.com/api/auth/exchange', () =>
    json({
      code: 0,
      message: 'ok',
      data: { accessToken: 'lobster-token', refreshToken: 'lobster-refresh', nickname: 'Lobster Tester' }
    })
  );

  await check('lobsterai: loopback callback exchanges the code', async () => {
    const started = await registry.start('lobsterai', { channelId: 'lobsterai' });
    assert.equal(started.mode, 'loopback');
    assert.match(started.authUrl, /lobsterai\.youdao\.com/);
    assert.match(started.redirectUri, /\/auth\/callback$/);

    const callback = await realFetch(`${started.redirectUri}?code=lb-code&state=${started.state}`);
    assert.equal(callback.status, 200);

    const done = registry.poll('lobsterai', started.state);
    assert.equal(done.status, 'success');
    assert.equal(done.credential.accessToken, 'lobster-token');
    assert.equal(done.credential.name, 'Lobster Tester');
  });

  /* ------------------------------------------------------------ registry API */

  await check('registry exposes all ten providers with their kinds', async () => {
    const described = registry.describe();
    const byId = Object.fromEntries(described.map((entry) => [entry.id, entry]));
    assert.deepEqual(Object.keys(byId).sort(), [
      'cline',
      'gemini-code-assist',
      'lobsterai',
      'loomy',
      'minimax-code',
      'openrouter',
      'qoder',
      'raccoon',
      'trae',
      'zcode'
    ]);
    assert.equal(byId.cline.kind, 'device-code');
    assert.equal(byId.zcode.kind, 'device-code');
    assert.equal(byId['minimax-code'].kind, 'device-code');
    assert.equal(byId.loomy.kind, 'sms');
    assert.equal(byId.loomy.needsInput, true);
    assert.equal(byId.lobsterai.kind, 'loopback');
    assert.equal(byId.raccoon.kind, 'qr');
    assert.equal(byId['gemini-code-assist'].kind, 'loopback');
  });

  await check('an unknown provider is rejected', async () => {
    await assert.rejects(() => registry.start('nope', {}), /没有 nope 的官方授权流程/);
    assert.throws(() => registry.poll('nope', 'x'), /没有 nope 的官方授权流程/);
  });
} finally {
  registry.close();
  globalThis.fetch = realFetch;
}

if (failures) {
  console.error(`\n${failures} oauth check(s) failed`);
  process.exit(1);
}
console.log('\nall oauth provider checks passed');
