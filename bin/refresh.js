import { loadConfig, saveConfig, CONFIG_PATH } from '../src/config.js';
import { WorkBuddyClient } from '../src/workbuddy.js';

const config = loadConfig();
const client = new WorkBuddyClient(config, (updated) => saveConfig(updated));

if (!config.upstream.refreshToken) {
  console.error(`No refresh token in ${CONFIG_PATH}. Run "npm run setup" first.`);
  process.exit(1);
}

try {
  await client.refreshToken();
  console.log('refresh OK');
  console.log('access token expires at:', new Date(client.tokenExpiresAt() * 1000).toISOString());
} catch (err) {
  console.error('refresh failed:', err.message);
  process.exit(1);
}
