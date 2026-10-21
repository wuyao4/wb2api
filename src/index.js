import { Runtime } from './runtime.js';
import { startServer } from './server.js';

const runtime = new Runtime();

const configured = runtime
  .enabledChannels()
  .some((channel) => channel.status?.().configured);

if (!configured) {
  console.warn(
    [
      '尚未配置任何可用渠道凭据。',
      `打开 http://127.0.0.1:${runtime.config.server.port}/ 在控制台登录 WorkBuddy，`,
      '或添加一个 OpenAI 兼容渠道（Kilo / OpenRouter / Ollama …）。',
      `（配置会保存到 ${runtime.configPath}）`,
      ''
    ].join('\n')
  );
}

startServer(runtime);
