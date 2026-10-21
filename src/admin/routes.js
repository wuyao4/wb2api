import { CHANNEL_TYPES, PROVIDER_PRESETS } from '../channels/catalog.js';
import { allConnectInfo, connectInfo, detectLocal, verifyProviderKey } from '../channels/connect.js';
import { supportedChannelTypes } from '../channels/registry.js';
import { generateApiKey } from '../core/credentials.js';
import { clipboardStatus } from '../core/clipboard.js';
import { qrSvg } from '../core/qr.js';
import { HttpError } from '../core/errors.js';
import { publicBaseUrl, readJson, sendJson } from '../core/http.js';
import { log, warn } from '../core/logger.js';
import { getLogs, getStats } from '../core/store.js';
import { slug } from '../core/util.js';
import { startProxy } from '../serving/start.js';
import { testChat } from '../serving/chat.js';

function modelRows(input) {
  if (Array.isArray(input)) return input;
  return String(input || '')
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * OAuth providers authenticate with a token, not an API key, so their channels
 * use the account runtime and store the credential in `accounts[]`.
 * OpenRouter is the exception: its OAuth result *is* an API key.
 */
const OAUTH_ACCOUNT_PROVIDERS = new Set([
  'cline',
  'qoder',
  'gemini-code-assist',
  'trae',
  'raccoon',
  'zcode',
  'minimax-code',
  'loomy',
  'lobsterai'
]);

/** Providers whose channel runtime is the WorkBuddy-family one. */
const WORKBUDDY_FAMILY_PROVIDERS = new Set(['workbuddy', 'codebuddy']);

function oauthChannelType(provider) {
  if (WORKBUDDY_FAMILY_PROVIDERS.has(provider)) return 'codebuddy';
  return OAUTH_ACCOUNT_PROVIDERS.has(provider) ? 'account' : 'openai-compatible';
}

function oauthChannelOptions(provider, preset) {
  if (provider === 'openrouter') {
    return { baseUrl: preset?.baseUrl || 'https://openrouter.ai/api/v1', preset: provider, apiKey: '' };
  }
  if (WORKBUDDY_FAMILY_PROVIDERS.has(provider)) {
    return { baseUrl: preset?.baseUrl || 'https://copilot.tencent.com' };
  }
  return {
    baseUrl: preset?.baseUrl || '',
    maxConcurrency: 4,
    headerTimeoutMs: 120000
  };
}

function channelSummary(runtime) {
  return runtime.statuses();
}

function publicDefaultModel(runtime) {
  try {
    const resolved = runtime.resolveModel(runtime.config.routing.defaultModel);
    return runtime.formatModelId(resolved.channel.id, resolved.model);
  } catch {
    return runtime.config.routing.defaultModel;
  }
}

async function handleChannelsCreate(runtime, req, res) {
  const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
  const type = String(body.type || 'openai-compatible');
  if (!supportedChannelTypes().includes(type)) {
    const planned = CHANNEL_TYPES.find((entry) => entry.type === type);
    return sendJson(res, 400, {
      ok: false,
      error: planned
        ? `${planned.label} 尚未实现。目前可用的渠道类型：${supportedChannelTypes().join(' / ')}`
        : `未知渠道类型：${type}`
    });
  }

  const id = slug(body.id || body.name || type, `channel-${Date.now()}`);
  if (runtime.getChannel(id)) {
    return sendJson(res, 409, { ok: false, error: `渠道 ${id} 已存在` });
  }

  const raw = {
    type,
    label: String(body.label || body.name || id).slice(0, 60),
    enabled: body.enabled !== false,
    accounts: []
  };

  if (type === 'openai-compatible') {
    raw.options = {
      baseUrl: String(body.baseUrl || '').trim(),
      apiKey: String(body.apiKey || '').trim(),
      models: modelRows(body.models)
    };
    if (body.preset) raw.options.preset = String(body.preset);
    if (body.headers && typeof body.headers === 'object') raw.options.headers = body.headers;
    raw.models = {
      default: String(body.defaultModel || '').trim()
    };
  } else {
    raw.options = {};
    if (body.baseUrl) raw.options.baseUrl = String(body.baseUrl).trim();
  }

  const channel = runtime.addChannel(id, raw);
  sendJson(res, 200, { ok: true, channel: channel.describe() });
}

function handleChannelsUpdate(runtime, req, res) {
  return readJson(req, runtime.config.server.requestBodyLimitMb).then((body) => {
    const id = String(body.id || '');
    if (!id) return sendJson(res, 400, { ok: false, error: '缺少渠道 id' });

    const patch = {};
    if (body.label !== undefined) patch.label = body.label;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.options && typeof body.options === 'object') {
      patch.options = { ...body.options };
      if (patch.options.models !== undefined) patch.options.models = modelRows(patch.options.models);
    }
    if (body.models && typeof body.models === 'object') patch.models = body.models;
    if (body.defaultModel !== undefined) {
      patch.models = { ...(patch.models || {}), default: String(body.defaultModel || '') };
    }

    const channel = runtime.updateChannel(id, patch);
    sendJson(res, 200, { ok: true, channel: channel.describe() });
  });
}

/**
 * Admin API dispatcher. Returns false for unknown paths so the caller can send
 * the standard 404 envelope.
 */
export async function handleAdmin(runtime, req, res, { pathname, url }) {
  try {
    if (req.method === 'GET' && pathname === '/admin/status') {
      const primary = runtime.defaultChannel();
      const status = primary?.status?.() || null;
      const primaryEntry = primary?.config?.accounts?.find((account) => account.id === 'primary');

      return sendJson(res, 200, {
        ok: true,
        running: runtime.running,
        canAutoLogin: Boolean(status?.capabilities?.login),
        hasDeviceToken: Boolean(primaryEntry?.deviceToken),
        baseUrl: publicBaseUrl(req, runtime.config),
        apiKey: runtime.config.server.apiKeys?.[0] || '',
        defaultModel: publicDefaultModel(runtime),
        models: status?.models || { contextWindow: {}, aliases: {} },
        user: status?.user || null,
        token: status?.token || { expiresAt: null, hasRefreshToken: false, maskedAccessToken: '' },
        accounts: status?.accounts || [],
        routing: status?.routing || { sessionAffinity: false, sessions: 0 },
        channels: channelSummary(runtime),
        channelTypes: CHANNEL_TYPES,
        presets: PROVIDER_PRESETS,
        connect: allConnectInfo(),
        // Global model routing is distinct from per-channel routing above;
        // the settings page edits this one.
        globalRouting: {
          defaultModel: runtime.config.routing.defaultModel,
          namespace: runtime.config.routing.namespace || 'auto',
          exposeUnprefixed: Boolean(runtime.config.routing.exposeUnprefixed),
          aliases: runtime.config.routing.aliases || {}
        },
        stats: getStats(),
        config: {
          configPath: runtime.configPath,
          host: runtime.listening?.host || runtime.config.server.host,
          port: runtime.listening?.port ?? runtime.config.server.port,
          authEnabled: !!runtime.config.server.apiKeys?.length,
          adminProtected: !!runtime.config.server.adminToken,
          namespace: runtime.config.routing.namespace || 'auto'
        }
      });
    }

    if (req.method === 'GET' && pathname === '/admin/models') {
      const data = await runtime.listModels();
      return sendJson(res, 200, { ok: true, data });
    }

    if (req.method === 'POST' && pathname === '/admin/test-chat') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const result = await testChat(runtime, body);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && pathname === '/admin/logs') {
      return sendJson(res, 200, { ok: true, logs: getLogs(60) });
    }

    if (req.method === 'POST' && pathname === '/admin/credentials') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const channel = runtime.pickChannel(body.channel);
      if (!channel?.applyCredentials) {
        return sendJson(res, 400, { ok: false, error: `${channel.label} 不支持手动写入凭据` });
      }
      const result = await channel.applyCredentials(body.source, {
        deviceToken: body.deviceToken,
        userId: body.userId
      });
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && pathname === '/admin/login/start') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const channel = runtime.pickChannel(body.channel);
      if (!channel?.loginStart) {
        return sendJson(res, 400, { ok: false, error: `${channel.label} 不支持浏览器登录` });
      }
      const result = await channel.loginStart(body);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && pathname === '/admin/login/status') {
      const state = url.searchParams.get('state') || '';
      const channel = runtime.pickChannel(url.searchParams.get('channel'));
      if (!channel?.loginStatus) {
        return sendJson(res, 400, { ok: false, error: `${channel.label} 不支持浏览器登录` });
      }
      const result = await channel.loginStatus({ state });
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && pathname === '/admin/accounts/toggle') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const channel = runtime.pickChannel(body.channel);
      if (!channel?.toggleAccount) {
        return sendJson(res, 400, { ok: false, error: '该渠道不支持账号管理' });
      }
      const status = channel.toggleAccount({ id: body.id, enabled: body.enabled !== false });
      return sendJson(res, 200, { ok: true, accounts: status.accounts });
    }

    if (req.method === 'POST' && pathname === '/admin/accounts/update') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const channel = runtime.pickChannel(body.channel);
      if (!channel?.updateAccount) {
        return sendJson(res, 400, { ok: false, error: '该渠道不支持账号管理' });
      }
      const status = channel.updateAccount(body);
      return sendJson(res, 200, { ok: true, accounts: status.accounts });
    }

    if (req.method === 'POST' && pathname === '/admin/accounts/remove') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const channel = runtime.pickChannel(body.channel);
      if (!channel?.removeAccount) {
        return sendJson(res, 400, { ok: false, error: '该渠道不支持账号管理' });
      }
      const status = channel.removeAccount(body.id);
      return sendJson(res, 200, { ok: true, accounts: status.accounts });
    }

    if (req.method === 'POST' && pathname === '/admin/start') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const result = await startProxy(runtime, { ...body, req });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/admin/stop') {
      runtime.setRunning(false);
      log('proxy stopped');
      return sendJson(res, 200, { ok: true, running: false });
    }

    if (req.method === 'POST' && pathname === '/admin/key') {
      const apiKey = generateApiKey();
      runtime.config.server.apiKeys = [apiKey];
      runtime.persist();
      return sendJson(res, 200, { ok: true, apiKey });
    }

    if (req.method === 'POST' && pathname === '/admin/refresh') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const channel = runtime.pickChannel(body.channel);
      if (!channel?.refreshAccount) {
        return sendJson(res, 400, { ok: false, error: `${channel.label} 不支持刷新令牌` });
      }
      const result = await channel.refreshAccount(body.accountId);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && pathname === '/admin/reload') {
      runtime.reload();
      return sendJson(res, 200, {
        ok: true,
        configPath: runtime.configPath,
        note: '监听地址与端口变更需要重启进程；渠道与凭据立即生效。'
      });
    }

    if (req.method === 'GET' && pathname === '/admin/channels') {
      return sendJson(res, 200, {
        ok: true,
        channels: runtime.describes(),
        types: CHANNEL_TYPES,
        presets: PROVIDER_PRESETS,
        connect: allConnectInfo(),
        routing: runtime.config.routing
      });
    }

    if (req.method === 'POST' && pathname === '/admin/channels/create') {
      return await handleChannelsCreate(runtime, req, res);
    }

    if (req.method === 'POST' && pathname === '/admin/channels/update') {
      return await handleChannelsUpdate(runtime, req, res);
    }

    if (req.method === 'POST' && pathname === '/admin/channels/test') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const channel = runtime.getChannelOrThrow(String(body.id || ''));
      const result = await channel.validate();
      if (!result.ok) {
        return sendJson(res, 400, { ok: false, error: result.error || '渠道不可用' });
      }
      let modelCount = 0;
      try {
        modelCount = (await channel.listModels({ force: true })).length;
      } catch {
        /* validate already proved the channel answers */
      }
      return sendJson(res, 200, {
        ok: true,
        channel: channel.id,
        label: channel.label,
        modelCount,
        message: `${channel.label} 可用${modelCount ? `，发现 ${modelCount} 个模型` : ''}`
      });
    }

    // ---- connection wizard -------------------------------------------------

    if (req.method === 'GET' && pathname === '/admin/connect/presets') {
      return sendJson(res, 200, { ok: true, presets: allConnectInfo() });
    }

    if (req.method === 'GET' && pathname === '/admin/connect/local') {
      const id = url.searchParams.get('preset') || '';
      const info = connectInfo(id);
      if (!info) return sendJson(res, 404, { ok: false, error: `未知预设：${id}` });
      const result = await detectLocal(id);
      return sendJson(res, 200, { ok: true, preset: id, ...result });
    }

    if (req.method === 'POST' && pathname === '/admin/connect/verify') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const presetId = String(body.preset || '');
      const info = connectInfo(presetId);
      if (!info) return sendJson(res, 404, { ok: false, error: `未知预设：${presetId}` });

      const result = await verifyProviderKey({
        presetId,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl || info.baseUrl,
        models: modelRows(body.models)
      });
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && pathname === '/admin/connect/clipboard') {
      // Reads the OS clipboard server-side, because the dashboard is a plain
      // localhost page and the browser may deny navigator.clipboard.readText().
      // Only a shape-checked key candidate is returned, never raw clipboard.
      const status = await clipboardStatus();
      return sendJson(res, 200, { ok: true, ...status });
    }

    if (req.method === 'POST' && pathname === '/admin/connect/oauth/start') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const provider = String(body.provider || 'openrouter');
      const session = await runtime.oauth.start(provider, {
        label: String(body.label || 'Buddy2API'),
        channelId: String(body.channelId || provider)
      });
      // QR flows render their symbol server-side so the pending login code
      // never reaches a third-party QR service.
      const payload = session.qrPayload || '';
      return sendJson(res, 200, {
        ok: true,
        provider,
        ...session,
        qrSvg: payload ? qrSvg(payload, { size: 208 }) : ''
      });
    }

    if (req.method === 'GET' && pathname === '/admin/connect/oauth/status') {
      const provider = url.searchParams.get('provider') || 'openrouter';
      const state = url.searchParams.get('state') || '';
      const result = runtime.oauth.poll(provider, state);

      if (result.status !== 'success') return sendJson(res, 200, { ok: true, provider, ...result });

      // The credential is minted by the provider; store it on the channel the
      // wizard targeted (creating the channel first if the user has none yet).
      const channelId = result.channelId || provider;
      const preset = connectInfo(channelId) || connectInfo(provider);
      let channel = runtime.getChannel(channelId);

      const account = {
        id: 'primary',
        label: result.account?.label || preset?.name || channelId,
        enabled: true,
        maxConcurrency: 4,
        ...result.credential
      };

      if (!channel) {
        channel = runtime.addChannel(channelId, {
          type: oauthChannelType(provider),
          label: preset?.name || channelId,
          oauth: provider,
          options: oauthChannelOptions(provider, preset),
          accounts: [account]
        });
      } else {
        runtime.setChannelAccount(channelId, account);
      }

      return sendJson(res, 200, {
        ok: true,
        provider,
        status: 'success',
        channel: channel.id,
        channelLabel: channel.label,
        account: { label: account.label, username: result.account?.username || '' },
        message: `${channel.label} 授权完成，凭据已保存`
      });
    }

    if (req.method === 'POST' && pathname === '/admin/connect/oauth/submit') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const provider = String(body.provider || '');
      const state_ = String(body.state || '');
      const result = await runtime.oauth.submit(provider, state_, body.code);
      return sendJson(res, 200, { ok: true, provider, ...result });
    }

    if (req.method === 'POST' && pathname === '/admin/connect/oauth/refresh') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const provider = String(body.provider || '');
      const channelId = String(body.channelId || provider);
      const channel = runtime.getChannelOrThrow(channelId);
      const entry = (channel.config.accounts || []).find((item) => item.id === (body.accountId || 'primary'));
      if (!entry) return sendJson(res, 404, { ok: false, error: '账号不存在' });

      const refreshed = await runtime.oauth.refresh(provider, entry);
      runtime.setChannelAccount(channelId, { ...entry, ...refreshed });
      return sendJson(res, 200, {
        ok: true,
        channel: channelId,
        accountId: entry.id,
        expiresAt: refreshed.expiresAt ? new Date(refreshed.expiresAt).toISOString() : null
      });
    }

    if (req.method === 'POST' && pathname === '/admin/channels/toggle') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const channel = runtime.toggleChannel(String(body.id || ''), body.enabled !== false);
      return sendJson(res, 200, { ok: true, channel: channel.describe() });
    }

    if (req.method === 'POST' && pathname === '/admin/channels/remove') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const id = String(body.id || '');
      runtime.removeChannel(id);
      return sendJson(res, 200, { ok: true, channels: runtime.describes() });
    }

    if (req.method === 'POST' && pathname === '/admin/routing/update') {
      const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
      const patch = {};
      for (const key of ['defaultModel', 'namespace', 'exposeUnprefixed']) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (patch.namespace !== undefined && !['auto', 'always', 'never'].includes(patch.namespace)) {
        return sendJson(res, 400, { ok: false, error: 'namespace 只能是 auto / always / never' });
      }
      if (body.aliases && typeof body.aliases === 'object') patch.aliases = body.aliases;
      return sendJson(res, 200, { ok: true, routing: runtime.updateRouting(patch) });
    }

    return false;
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { ok: false, error: error.message });
      return true;
    }
    warn(`admin ${pathname} failed: ${error.message}`);
    sendJson(res, 500, { ok: false, error: error.message });
    return true;
  }
}
