import { loadConfig, CONFIG_PATH } from './config.js';

const config = loadConfig();

if (!config.upstream.accessToken && !config.upstream.refreshToken) {
  console.warn(
    [
      '尚未配置 WorkBuddy 凭据。',
      `打开 http://127.0.0.1:${config.server.port}/ 在控制台粘贴 token 即可开始。`,
      `（凭据会保存到 ${CONFIG_PATH}）`,
      ''
    ].join('\n')
  );
}

await import('./server.js');
