import { CONFIG_PATH, loadConfig, saveConfig } from '../src/core/config.js';
import { WorkBuddyClient } from '../src/channels/workbuddy/client.js';
import { clientConfigFor } from '../src/channels/workbuddy/config.js';

const config = loadConfig();
const channel = config.channels?.workbuddy;
const entry = channel?.accounts.find((account) => account.id === 'primary') || channel?.accounts?.[0];

if (!entry?.refreshToken) {
  console.error(`No WorkBuddy refresh token in ${CONFIG_PATH}. Run "npm run setup" first.`);
  process.exit(1);
}

const client = new WorkBuddyClient(clientConfigFor(channel, entry, config.retry), () => {});

try {
  await client.refreshToken();
  entry.accessToken = client.upstream.accessToken;
  entry.refreshToken = client.upstream.refreshToken;
  saveConfig(config);
  console.log('refresh OK');
  console.log('access token expires at:', new Date(client.tokenExpiresAt() * 1000).toISOString());
} catch (err) {
  console.error('refresh failed:', err.message);
  process.exit(1);
}
