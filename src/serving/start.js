import { generateApiKey } from '../core/credentials.js';
import { HttpError } from '../core/errors.js';
import { publicBaseUrl } from '../core/http.js';
import { log } from '../core/logger.js';

function describeErrorList(results) {
  return results
    .filter((entry) => !entry.ok && entry.error)
    .map((entry) => `${entry.channel.label}: ${entry.error}`)
    .join('；');
}

/**
 * Validate every enabled channel, then mark the proxy as running.
 *
 * Kept separate from the HTTP layer so the connection wizard can reuse the
 * exact same code path for its "一键启动" button.
 */
export async function startProxy(runtime, options = {}) {
  const enabled = runtime.enabledChannels();
  if (!enabled.length) {
    throw new HttpError(400, '请先添加并启用至少一个渠道。');
  }

  const validation = await Promise.all(
    enabled.map(async (channel) => {
      try {
        return { channel, ...(await channel.validate()) };
      } catch (error) {
        return { channel, ok: false, error: error.message };
      }
    })
  );

  const usable = validation.filter((entry) => entry.ok);
  if (!usable.length) {
    throw new HttpError(400, `渠道校验失败：${describeErrorList(validation) || '没有可用渠道'}`);
  }

  const requestedModel = String(options.defaultModel || runtime.config.routing.defaultModel || '').trim();
  let target = runtime.resolveModel(requestedModel);
  if (!usable.some((entry) => entry.channel.id === target.channel.id)) {
    const alternative = usable.find((entry) => entry.channel.hasModel(target.model));
    if (alternative) {
      target = {
        channel: alternative.channel,
        model: alternative.channel.resolveModel(target.model),
        requestedId: requestedModel
      };
    } else {
      // The configured default points at a channel that cannot answer right
      // now (logged out, missing key, …). Rather than refusing to start, fall
      // back to the first usable channel and its own default model, and say so.
      const fallbackChannel = usable[0].channel;
      let model = fallbackChannel.config?.models?.default || '';
      if (!model || !fallbackChannel.hasModel(model)) {
        const models = usable[0].models || (await fallbackChannel.listModels().catch(() => []));
        model = models[0]?.id || fallbackChannel.resolveModel(requestedModel);
      }
      target = { channel: fallbackChannel, model, requestedId: requestedModel };
      log(
        `default model ${requestedModel} is unavailable (${describeErrorList(validation)}); ` +
          `falling back to ${fallbackChannel.id}/${model}`
      );
    }
  }

  const channel = target.channel;
  const requestedContext = Number(options.contextWindow || 0);
  if (requestedContext > 0) {
    const info = channel.modelInfo?.(target.model) || null;
    const supported = info?.contextWindow?.supportedLengths || info?.supported_context_lengths || [];
    const maxContext = Number(info?.maxInputTokens || info?.max_input_tokens || info?.max_context_length || 0);
    if (Array.isArray(supported) && supported.length && !supported.includes(requestedContext)) {
      throw new HttpError(
        400,
        `该模型支持的上下文长度为 ${supported.map((value) => `${value / 1000}K`).join(' / ')}。`
      );
    }
    if (maxContext && requestedContext > maxContext) {
      throw new HttpError(400, `上下文长度不能超过模型上限 ${maxContext}。`);
    }
    channel.config.models.contextWindow.overrides = channel.config.models.contextWindow.overrides || {};
    channel.config.models.contextWindow.overrides[target.model] = requestedContext;
  }

  let apiKey = String(options.apiKey || '').trim();
  if (apiKey === 'sk-wb2api-local') apiKey = '';
  if (apiKey && !/^[A-Za-z0-9._-]{8,128}$/.test(apiKey)) {
    throw new HttpError(400, 'API Key 只能包含字母、数字、点、下划线、短横线，长度 8-128。');
  }
  if (!apiKey) {
    apiKey =
      runtime.config.server.apiKeys.find((key) => key && key !== 'sk-wb2api-local') || generateApiKey();
  }

  runtime.config.server.apiKeys = [apiKey];
  runtime.config.routing.defaultModel = `${channel.id}/${target.model}`;
  runtime.config.server.running = true;
  runtime.persist();

  log(`proxy started (default model: ${runtime.config.routing.defaultModel})`);

  let modelCount = 0;
  try {
    modelCount = (await runtime.listModels()).length;
  } catch {
    /* the dashboard only displays this number */
  }

  return {
    ok: true,
    running: true,
    channel: channel.id,
    channelLabel: channel.label,
    baseUrl: options.req ? publicBaseUrl(options.req, runtime.config) : '',
    apiKey,
    defaultModel: runtime.formatModelId(channel.id, target.model),
    fellBack: Boolean(target.requestedId && target.requestedId !== `${channel.id}/${target.model}` && target.requestedId !== target.model),
    requestedModel,
    contextWindow:
      channel.config.models.contextWindow.overrides?.[target.model] ??
      channel.config.models.contextWindow.default,
    modelCount
  };
}
