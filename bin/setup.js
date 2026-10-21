import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { CONFIG_PATH, loadConfig, saveConfig } from '../src/core/config.js';
import { WorkBuddyClient } from '../src/channels/workbuddy/client.js';
import { clientConfigFor } from '../src/channels/workbuddy/config.js';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const config = loadConfig();
const channel = config.channels?.workbuddy;
if (!channel) {
  console.error('config.json 中没有 workbuddy 渠道。先在控制台添加一个 WorkBuddy 渠道，或删除 channels 让默认配置生成。');
  process.exit(1);
}
const entry = channel.accounts.find((account) => account.id === 'primary') || channel.accounts[0];

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

const refreshToken = arg('refresh-token') || (await ask('Refresh token', entry.refreshToken));
const accessToken = arg('access-token') || (await ask('Access token (optional)', entry.accessToken));
const deviceToken = arg('device-token') || (await ask('Device token (X-Device-Token)', entry.deviceToken));
const userId = arg('user-id') || (await ask('User id (X-User-Id)', entry.userId));

rl.close();

if (!refreshToken && !accessToken) {
  console.error('At least one of refresh token / access token is required.');
  process.exit(1);
}

entry.refreshToken = refreshToken;
entry.accessToken = accessToken;
if (deviceToken) entry.deviceToken = deviceToken;
if (userId) entry.userId = userId;

if (fs.existsSync(CONFIG_PATH)) {
  const backup = `${CONFIG_PATH}.bak`;
  fs.copyFileSync(CONFIG_PATH, backup);
  console.log(`previous config backed up to ${backup}`);
}
saveConfig(config);
console.log(`saved ${CONFIG_PATH}`);

if (refreshToken) {
  const client = new WorkBuddyClient(clientConfigFor(channel, entry, config.retry), () => {});
  try {
    await client.refreshToken();
    entry.accessToken = client.upstream.accessToken;
    entry.refreshToken = client.upstream.refreshToken;
    saveConfig(config);
    console.log('access token refreshed, expires at:', new Date(client.tokenExpiresAt() * 1000).toISOString());
  } catch (err) {
    console.error('token refresh failed (credentials saved anyway):', err.message);
  }
}

console.log('done. start the proxy with: npm start');
