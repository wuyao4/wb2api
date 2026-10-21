/**
 * Live probe for the connection layer against real providers.
 *
 * Runs only when explicitly enabled, because it hits third-party endpoints and
 * consumes (a tiny amount of) the keys supplied:
 *
 *   WB2API_LIVE=1 node scripts/live-connect.mjs
 *   WB2API_LIVE=1 WB2API_LIVE_GROQ_KEY=gsk_... node scripts/live-connect.mjs
 *
 * With no keys it still checks every provider's key page, which is the part
 * that can be verified without an account.
 */
import { allConnectInfo, verifyProviderKey } from '../src/channels/connect.js';

if (process.env.WB2API_LIVE !== '1') {
  console.log('skip: set WB2API_LIVE=1 to probe real endpoints');
  process.exit(0);
}

const KEY_ENV = {
  openrouter: 'WB2API_LIVE_OPENROUTER_KEY',
  groq: 'WB2API_LIVE_GROQ_KEY',
  deepseek: 'WB2API_LIVE_DEEPSEEK_KEY',
  gemini: 'WB2API_LIVE_GEMINI_KEY',
  siliconflow: 'WB2API_LIVE_SILICONFLOW_KEY',
  nvidia: 'WB2API_LIVE_NVIDIA_KEY',
  cerebras: 'WB2API_LIVE_CEREBRAS_KEY',
  mistral: 'WB2API_LIVE_MISTRAL_KEY',
  together: 'WB2API_LIVE_TOGETHER_KEY',
  fireworks: 'WB2API_LIVE_FIREWORKS_KEY',
  xai: 'WB2API_LIVE_XAI_KEY',
  moonshot: 'WB2API_LIVE_MOONSHOT_KEY',
  zai: 'WB2API_LIVE_ZAI_KEY',
  minimax: 'WB2API_LIVE_MINIMAX_KEY',
  'opencode-zen': 'WB2API_LIVE_OPENCODE_KEY',
  vercel: 'WB2API_LIVE_VERCEL_KEY'
};

let failures = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

console.log('== key pages ==');
for (const entry of allConnectInfo()) {
  if (!entry.keyUrl) continue;
  await run(`${entry.id} key page reachable`, async () => {
    const res = await fetch(entry.keyUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Buddy2API-live-probe)' }
    });
    // Cloudflare-protected consoles may answer 403 to non-browser clients;
    // that is a bot gate, not a dead link, so only 404/410 fail the check.
    if (res.status === 404 || res.status === 410) throw new Error(`HTTP ${res.status}`);
    console.log(`        ${entry.id}: HTTP ${res.status}`);
  });
}

console.log('\n== supplied keys ==');
for (const [id, env] of Object.entries(KEY_ENV)) {
  const key = process.env[env];
  if (!key) {
    console.log(`        ${id}: no ${env}, skipped`);
    continue;
  }
  await run(`${id} key verifies`, async () => {
    const result = await verifyProviderKey({ presetId: id, apiKey: key });
    console.log(`        ${result.message}`);
  });
}

if (failures) {
  console.error(`\n${failures} live check(s) failed`);
  process.exit(1);
}
console.log('\nlive connection probe finished');
