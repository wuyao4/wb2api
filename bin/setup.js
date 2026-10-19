import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, saveConfig, CONFIG_PATH } from '../src/config.js';
import { WorkBuddyClient } from '../src/workbuddy.js';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const config = loadConfig();
const rl = readline.createInterface({ input: stdin, output: stdout });

async function ask(label, current) {
  const hint = current ? ` [keep ${String(current).slice(0, 12)}...]` : '';
  const answer = (await rl.question(`${label}${hint}: `)).trim();
  return answer || current || '';
}

console.log('WorkBuddy credential setup');
console.log('Values come from a WorkBuddy request captured in your proxy/HAR:');
console.log('  Authorization: Bearer <access token>   -> accessToken');
console.log('  X-Refresh-Token: <token>               -> refreshToken');
console.log('  X-Device-Token: v3:...                 -> deviceToken');
console.log('  X-User-Id: <uuid>                      -> userId');
console.log('');

const refreshToken =
  arg('refresh-token') ||
  (await ask('Refresh token', config.upstream.refreshToken));
const accessToken =
  arg('access-token') || (await ask('Access token (optional)', config.upstream.accessToken));
const deviceToken =
  arg('device-token') || (await ask('Device token (X-Device-Token)', config.upstream.deviceToken));
const userId = arg('user-id') || (await ask('User id (X-User-Id)', config.upstream.userId));

rl.close();

if (!refreshToken && !accessToken) {
  console.error('At least one of refresh token / access token is required.');
  process.exit(1);
}

config.upstream.refreshToken = refreshToken;
config.upstream.accessToken = accessToken;
if (deviceToken) config.upstream.deviceToken = deviceToken;
if (userId) config.upstream.userId = userId;

if (fs.existsSync(CONFIG_PATH)) {
  const backup = `${CONFIG_PATH}.bak`;
  fs.copyFileSync(CONFIG_PATH, backup);
  console.log(`previous config backed up to ${backup}`);
}
saveConfig(config);
console.log(`saved ${CONFIG_PATH}`);

if (refreshToken) {
  const client = new WorkBuddyClient(config, (updated) => saveConfig(updated));
  try {
    await client.refreshToken();
    console.log('access token refreshed, expires at:', new Date(client.tokenExpiresAt() * 1000).toISOString());
  } catch (err) {
    console.error('token refresh failed (credentials saved anyway):', err.message);
  }
}

console.log('done. start the proxy with: npm start');
