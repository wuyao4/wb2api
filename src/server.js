import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleAdmin } from './admin/routes.js';
import { applyCors, isAdminAllowed, isAuthorized, sendJson, serveStatic } from './core/http.js';
import { error, log } from './core/logger.js';
import { handleAnthropicMessages, handleModels, handleOpenAIChat } from './serving/chat.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

export function createServer(runtime) {
  const server = http.createServer(async (req, res) => {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'GET' && !pathname.startsWith('/v1') && !pathname.startsWith('/admin')) {
        if (serveStatic(PUBLIC_DIR, req, res, pathname)) return;
      }

      if (req.method === 'GET' && pathname === '/healthz') {
        return sendJson(res, 200, {
          ok: true,
          uptime: process.uptime(),
          running: runtime.running,
          channels: runtime.channels().map((channel) => ({
            id: channel.id,
            type: channel.type,
            enabled: channel.enabled
          }))
        });
      }

      if (pathname.startsWith('/admin')) {
        if (!isAdminAllowed(req, runtime.config)) {
          return sendJson(res, 403, {
            ok: false,
            error: '管理接口仅允许本机访问。远程访问请配置 server.adminToken 并携带 X-Admin-Token。'
          });
        }
        const handled = await handleAdmin(runtime, req, res, { pathname, url });
        if (handled !== false) return;
        return sendJson(res, 404, { ok: false, error: `admin route not found: ${req.method} ${pathname}` });
      }

      if (!isAuthorized(req, runtime.config)) {
        return sendJson(res, 401, {
          error: { message: 'invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' }
        });
      }

      if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
        return await handleOpenAIChat(runtime, req, res);
      }
      if (req.method === 'POST' && pathname === '/v1/messages') {
        return await handleAnthropicMessages(runtime, req, res);
      }
      if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
        return await handleModels(runtime, req, res);
      }

      return sendJson(res, 404, {
        error: { message: `no route for ${req.method} ${pathname}`, type: 'invalid_request_error' }
      });
    } catch (err) {
      error(`${req.method} ${pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) {
        sendJson(res, err.status || 500, {
          error: { message: err.message, type: 'internal_error' }
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  server.requestTimeout = 0;
  server.headersTimeout = 65000;
  server.keepAliveTimeout = 72000;
  server.noDelay = true;

  // Capture the real bound address for any caller (not just startServer).
  // Port 0 means "let the OS choose", and the dashboard must show that port.
  server.on('listening', () => {
    const address = server.address();
    runtime.listening = {
      host: typeof address === 'object' && address ? address.address : runtime.config.server.host,
      port: typeof address === 'object' && address ? address.port : runtime.config.server.port
    };
  });

  return server;
}

export function startServer(runtime) {
  const server = createServer(runtime);
  const { host, port } = runtime.config.server;

  server.on('listening', () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const actualHost = runtime.listening?.host || host;

    log(`buddy2api listening on http://${actualHost}:${actualPort}`);
    log(`dashboard: http://127.0.0.1:${actualPort}/`);
    log(
      `default model: ${runtime.config.routing.defaultModel}, proxy: ${runtime.running ? 'running' : 'stopped'}`
    );
    log(`channels: ${runtime.channels().map((channel) => `${channel.id}(${channel.type})`).join(', ') || 'none'}`);
    log(`config: ${runtime.configPath}`);

    const primary = runtime.defaultChannel();
    if (primary?.hasCredentials?.()) {
      primary.validate?.().catch?.((err) => log(`token check failed: ${err.message}`));
    }
  });

  server.listen(port, host);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('shutting down');
      runtime.close?.();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }

  return server;
}
