import { abortOnDisconnect, readJson, sendJson, sendOpenAIError } from '../core/http.js';
import { log, warn, error } from '../core/logger.js';
import { recordRequest } from '../core/store.js';
import { HttpError } from '../core/errors.js';
import {
  anthropicError,
  anthropicToOpenAI,
  openAIToAnthropicMessage,
  relayAnthropicStream
} from '../protocol/anthropic.js';
import { collectOpenAICompletion, relayOpenAIStream } from '../protocol/openai.js';

async function readUpstreamError(upstream) {
  const text = await upstream.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  const message = json?.msg || json?.error?.message || json?.message || text.slice(0, 500) || `upstream returned ${upstream.status}`;
  const detail = [
    message,
    json?.code != null ? `(code ${json.code})` : '',
    json?.requestId ? `[request ${json.requestId}]` : ''
  ]
    .filter(Boolean)
    .join(' ');
  const err = new Error(detail);
  err.status = upstream.status;
  err.code = json?.code ?? json?.error?.code ?? null;
  return err;
}

function notRunningOpenAI(res) {
  return sendOpenAIError(res, 503, '反代尚未启动，请打开控制台点击「启动反代」。', {
    type: 'service_unavailable'
  });
}

function notRunningAnthropic(res) {
  return anthropicError(res, 503, '反代尚未启动，请打开控制台点击「启动反代」。', 'service_unavailable');
}

function logLine(kind, { status, requestedModel, model, account, stream, elapsed, ttfb, usage }) {
  const parts = [
    `${status}`,
    `model=${requestedModel}${requestedModel !== model ? `->${model}` : ''}`,
    `account=${account || '-'}`,
    `stream=${stream}`,
    `${elapsed}ms`
  ];
  if (ttfb !== null) parts.push(`ttfb=${ttfb}ms`);
  if (usage) parts.push(`tokens=${usage.prompt_tokens ?? '?'}/${usage.completion_tokens ?? '?'}`);
  log(`${kind} ${parts.join(' ')}`);
}

export async function handleOpenAIChat(runtime, req, res) {
  const body = await readJson(req, runtime.config.server.requestBodyLimitMb);
  if (!Array.isArray(body.messages)) {
    return sendOpenAIError(res, 400, '`messages` must be an array', { type: 'invalid_request_error' });
  }
  if (!runtime.running) return notRunningOpenAI(res);

  const requestedModel = body.model || runtime.config.routing.defaultModel;
  const resolved = runtime.resolveModel(requestedModel);
  const { channel } = resolved;
  const upstreamBody = channel.prepareRequest(body, resolved.model);
  const conversationId = req.headers['x-conversation-id'] || body.conversation_id;
  const sessionKey = channel.sessionKey
    ? channel.sessionKey(req.headers, upstreamBody)
    : '';
  const signal = abortOnDisconnect(res);
  const started = Date.now();

  let slot;
  try {
    slot = await channel.chat({
      body: upstreamBody,
      options: { signal, conversationId },
      sessionKey,
      model: resolved.model
    });
  } catch (err) {
    if (signal.aborted) return;
    warn(`[${channel.id}] chat failed before response: ${err.message}`);
    recordRequest({
      kind: 'chat',
      channel: channel.id,
      channelLabel: channel.label,
      model: requestedModel,
      upstreamModel: resolved.model,
      stream: !!body.stream,
      status: err.status || 502,
      durationMs: Date.now() - started,
      error: err.message
    });
    return sendOpenAIError(res, err.status || 502, err.message, { type: 'upstream_connection_error' });
  }

  const { res: upstream, release, model, account } = slot;
  let usage = null;
  let errorMessage = null;
  let firstTokenMs = null;
  const markFirstToken = () => {
    if (firstTokenMs === null) firstTokenMs = Date.now() - started;
  };

  try {
    if (!upstream.ok) {
      const err = await readUpstreamError(upstream);
      errorMessage = err.message;
      const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : upstream.status;
      const message =
        upstream.status === 429
          ? `${err.message} - ${channel.label} 限流 / 模型繁忙。请稍后重试、切换模型，或配置 models.fallback。`
          : err.message;
      return sendOpenAIError(res, status, message, { code: err.code });
    }

    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      await relayOpenAIStream({
        body: upstream.body,
        res,
        requestedModel,
        upstreamModel: model,
        onFirstChunk: markFirstToken,
        onUsage: (value) => {
          usage = value;
        }
      });
    } else {
      const completion = await collectOpenAICompletion({
        body: upstream.body,
        requestedModel,
        onFirstChunk: markFirstToken
      });
      usage = completion.usage;
      sendJson(res, 200, completion);
    }
  } catch (err) {
    if (signal.aborted) return;
    errorMessage = err.message;
    error(`[${channel.id}] chat stream failed: ${err.message}`);
    if (!res.headersSent) {
      sendOpenAIError(res, 502, err.message);
    } else {
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_error' } })}\n\n`);
      res.write('data: [DONE]\n\n');
    }
  } finally {
    release();
    recordRequest({
      kind: 'chat',
      channel: channel.id,
      channelLabel: channel.label,
      model: requestedModel,
      upstreamModel: model,
      account: account?.label || '',
      stream: !!body.stream,
      status: res.statusCode || 200,
      durationMs: Date.now() - started,
      ttfbMs: firstTokenMs,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      error: errorMessage
    });
    if (runtime.config.logging.requests) {
      logLine('chat', {
        status: res.statusCode || 200,
        requestedModel,
        model,
        account: account?.label,
        stream: !!body.stream,
        elapsed: Date.now() - started,
        ttfb: firstTokenMs,
        usage
      });
    }
    if (!res.writableEnded) res.end();
  }
}

export async function handleAnthropicMessages(runtime, req, res) {
  const request = await readJson(req, runtime.config.server.requestBodyLimitMb);
  if (!Array.isArray(request.messages)) {
    return anthropicError(res, 400, '`messages` must be an array', 'invalid_request_error');
  }
  if (!runtime.running) return notRunningAnthropic(res);

  const requestedModel = request.model || runtime.config.routing.defaultModel;
  const resolved = runtime.resolveModel(requestedModel);
  const { channel } = resolved;
  const converted = anthropicToOpenAI(request);
  const upstreamBody = channel.prepareRequest(converted, resolved.model);
  const sessionKey = channel.sessionKey ? channel.sessionKey(req.headers, upstreamBody) : '';
  const signal = abortOnDisconnect(res);
  const started = Date.now();

  let slot;
  try {
    slot = await channel.chat({
      body: upstreamBody,
      options: { signal },
      sessionKey,
      model: resolved.model
    });
  } catch (err) {
    if (signal.aborted) return;
    warn(`[${channel.id}] messages failed before response: ${err.message}`);
    recordRequest({
      kind: 'messages',
      channel: channel.id,
      channelLabel: channel.label,
      model: requestedModel,
      upstreamModel: resolved.model,
      stream: !!request.stream,
      status: err.status || 502,
      durationMs: Date.now() - started,
      error: err.message
    });
    return anthropicError(res, err.status || 502, err.message);
  }

  const { res: upstream, release, model, account } = slot;
  let usage = null;
  let errorMessage = null;
  let firstTokenMs = null;
  const markFirstToken = () => {
    if (firstTokenMs === null) firstTokenMs = Date.now() - started;
  };

  try {
    if (!upstream.ok) {
      const err = await readUpstreamError(upstream);
      errorMessage = err.message;
      return anthropicError(res, upstream.status >= 500 ? 502 : upstream.status, err.message);
    }

    if (request.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      await relayAnthropicStream({
        body: upstream.body,
        res,
        requestedModel,
        onFirstChunk: markFirstToken,
        onUsage: (value) => {
          usage = value;
        }
      });
    } else {
      const completion = await collectOpenAICompletion({
        body: upstream.body,
        requestedModel,
        onFirstChunk: markFirstToken
      });
      usage = completion.usage;
      sendJson(res, 200, openAIToAnthropicMessage(completion, requestedModel));
    }
  } catch (err) {
    if (signal.aborted) return;
    errorMessage = err.message;
    error(`[${channel.id}] messages stream failed: ${err.message}`);
    if (!res.headersSent) anthropicError(res, 502, err.message);
    else res.end();
  } finally {
    release();
    recordRequest({
      kind: 'messages',
      channel: channel.id,
      channelLabel: channel.label,
      model: requestedModel,
      upstreamModel: model,
      account: account?.label || '',
      stream: !!request.stream,
      status: res.statusCode || 200,
      durationMs: Date.now() - started,
      ttfbMs: firstTokenMs,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      error: errorMessage
    });
    if (runtime.config.logging.requests) {
      logLine('messages', {
        status: res.statusCode || 200,
        requestedModel,
        model,
        account: account?.label,
        stream: !!request.stream,
        elapsed: Date.now() - started,
        ttfb: firstTokenMs,
        usage
      });
    }
    if (!res.writableEnded) res.end();
  }
}

export async function handleModels(runtime, req, res) {
  try {
    const data = await runtime.listModels();
    sendJson(res, 200, { object: 'list', data });
  } catch (err) {
    if (err instanceof HttpError) return sendOpenAIError(res, err.status, err.message);
    throw err;
  }
}
