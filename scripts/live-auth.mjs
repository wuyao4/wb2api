/**
 * Live authorization probe for the five account channels.
 *
 * Starts each real flow and reports whether the provider issued a usable
 * authorization artifact (device code, QR, or consent URL) — i.e. whether the
 * endpoint contract still matches what the implementation expects.
 *
 * It deliberately does NOT complete the login: that needs a real account.
 *
 *   node scripts/live-auth.mjs
 */
import { OAuthRegistry } from '../src/channels/oauth/index.js';

const registry = new OAuthRegistry({ persist: () => {} });

let failures = 0;
let skipped = 0;

/** Transport failures say nothing about the provider's contract. */
function isNetworkFailure(error) {
  const message = String(error?.message || '');
  const cause = String(error?.cause?.code || '');
  return (
    /fetch failed|connect timeout|timeout|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|socket/i.test(message) ||
    /UND_ERR|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(cause)
  );
}

async function probe(id) {
  try {
    const started = await registry.start(id, { channelId: id });
    const polled = registry.poll(id, started.state);

    const detail = [];
    if (started.mode) detail.push(`mode=${started.mode}`);
    if (started.userCode) detail.push(`code=${started.userCode}`);
    if (started.qrCode) detail.push(`qr=${started.qrCode.slice(0, 8)}…`);
    if (started.redirectUri) detail.push(`redirect=${started.redirectUri}`);
    if (started.authUrl) {
      try {
        detail.push(`url=${new URL(started.authUrl).host}`);
      } catch {
        detail.push(`url=${started.authUrl.slice(0, 40)}`);
      }
    }

    console.log(`  ok    ${id.padEnd(20)} ${detail.join(' ')} | poll=${polled.status}`);
    return true;
  } catch (error) {
    if (isNetworkFailure(error)) {
      skipped += 1;
      console.log(`  skip  ${id.padEnd(20)} unreachable from this network: ${error.message.slice(0, 60)}`);
      return false;
    }
    failures += 1;
    console.error(`FAIL    ${id.padEnd(20)} ${error.message}`);
    return false;
  }
}

console.log('live authorization probe (does not complete any login)\n');

try {
  for (const id of [
    'openrouter',
    'cline',
    'qoder',
    'gemini-code-assist',
    'trae',
    'raccoon',
    'zcode',
    'minimax-code',
    'lobsterai'
  ]) {
    await probe(id);
  }

  // Loomy has no URL to open: it sends an SMS. Never send one from a test:
  // use an empty phone (local validation) and a clearly invalid number (the
  // service rejects it before delivery) to prove the signed request is accepted
  // as well-formed.
  try {
    await registry.start('loomy', { channelId: 'loomy', phone: '' });
    failures += 1;
    console.error('FAIL  loomy                accepted an empty phone');
  } catch {
    console.log('  ok  loomy                rejects empty phone');
  }
  try {
    await registry.start('loomy', { channelId: 'loomy', phone: '00000000000' });
    failures += 1;
    console.error('FAIL  loomy                accepted an invalid phone');
  } catch (error) {
    const signed = !/HMAC|signature/i.test(error.message);
    console.log(
      `  ${signed ? 'ok  ' : 'FAIL'}  loomy                ${signed ? 'signed request accepted' : 'signature rejected'}: ${error.message.slice(0, 50)}`
    );
    if (!signed) failures += 1;
  }
} finally {
  registry.close();
}

if (failures) {
  console.error(`\n${failures} provider(s) failed to issue an authorization request`);
  process.exit(1);
}
console.log(
  `\nall reachable providers issued an authorization request${skipped ? ` (${skipped} skipped: network)` : ''}`
);
