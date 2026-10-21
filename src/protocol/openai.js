import { readSSE, writeWithBackpressure } from '../core/sse.js';

export { readSSE, writeWithBackpressure };

const PASSTHROUGH_FIELDS = [
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'max_tokens',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'response_format',
  'reasoning_effort',
  'verbosity',
  'reasoning_summary',
  'extra_vars',
  'parallel_tool_calls',
  'logprobs',
  'top_logprobs',
  'user'
];

function normalizeMessages(messages, promptConfig) {
  const out = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];

  // OpenAI's newer "developer" role means the same thing upstream expects as
  // "system"; WorkBuddy only recognises the first message when it is "system".
  for (const message of out) {
    if (message.role === 'developer') message.role = 'system';
  }

  if (promptConfig?.injectWhenMissing && out[0]?.role !== 'system') {
    out.unshift({ role: 'system', content: promptConfig.system || 'You are a helpful assistant.' });
  }
  return out;
}

/**
 * Build a WorkBuddy-style upstream body.
 *
 * WorkBuddy only supports streaming, so `stream` is always true; the proxy
 * aggregates when the client asked for a non-streaming response.
 */
export function prepareChatBody(promptConfig, requestBody, upstreamModel) {
  const body = {
    model: upstreamModel,
    messages: normalizeMessages(requestBody.messages, promptConfig),
    stream: true,
    stream_options: { ...(requestBody.stream_options || {}), include_usage: true }
  };

  if (requestBody.max_completion_tokens && requestBody.max_tokens === undefined) {
    body.max_tokens = requestBody.max_completion_tokens;
  }

  for (const key of PASSTHROUGH_FIELDS) {
    if (requestBody[key] !== undefined && requestBody[key] !== null) body[key] = requestBody[key];
  }

  return body;
}

/**
 * Build an upstream body for a generic OpenAI-compatible gateway.
 *
 * Unlike WorkBuddy this keeps the caller's fields intact — third-party
 * gateways have their own extensions and dropping unknown keys is worse than
 * forwarding one they ignore.
 */
export function prepareCompatBody(requestBody, upstreamModel, options = {}) {
  const body = {
    ...requestBody,
    model: upstreamModel,
    // A single transport path (always SSE upstream) keeps the relay simple and
    // matches every gateway we target.
    stream: true
  };

  if (options.includeUsage !== false) {
    body.stream_options = { ...(requestBody.stream_options || {}), include_usage: true };
  }

  return body;
}

function usageFromTail(tail) {
  if (!tail.includes('"usage":{')) return null;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('data:') || !line.includes('"usage":{')) continue;
    try {
      const chunk = JSON.parse(line.slice(5).trim());
      if (chunk.usage) return chunk.usage;
    } catch {
      /* partial line */
    }
  }
  return null;
}

async function passthroughStream(body, res, { onUsage, onFirstChunk }) {
  const decoder = new TextDecoder();
  let tail = '';
  let probe = '';
  let sawDone = false;
  let first = true;

  for await (const chunk of body) {
    if (first) {
      first = false;
      if (onFirstChunk) onFirstChunk();
    }
    await writeWithBackpressure(res, chunk);

    const text = decoder.decode(chunk, { stream: true });
    tail += text;
    if (tail.length > 131072) tail = tail.slice(-65536);
    probe = (probe + text).slice(-16);
    if (!sawDone && probe.includes('[DONE]')) sawDone = true;
  }

  const rest = decoder.decode();
  if (rest) {
    tail += rest;
    probe = (probe + rest).slice(-16);
  }
  if (!sawDone && probe.includes('[DONE]')) sawDone = true;

  const usage = usageFromTail(tail.slice(-65536));
  if (usage && onUsage) onUsage(usage);
  if (!sawDone) await writeWithBackpressure(res, 'data: [DONE]\n\n');
}

async function rewriteStream(body, res, { requestedModel, onUsage, onFirstChunk }) {
  let sawDone = false;
  let skipBlank = false;
  let first = true;

  for await (const event of readSSE(body)) {
    if (first) {
      first = false;
      if (onFirstChunk) onFirstChunk();
    }

    if (event.done) {
      sawDone = true;
      await writeWithBackpressure(res, 'data: [DONE]\n\n');
      continue;
    }

    if (event.data) {
      const chunk = event.data;
      if (requestedModel && chunk.model) chunk.model = requestedModel;
      if (chunk.usage && onUsage) onUsage(chunk.usage);
      await writeWithBackpressure(res, `data: ${JSON.stringify(chunk)}\n\n`);
      skipBlank = true;
      continue;
    }

    if (event.raw) {
      await writeWithBackpressure(res, `${event.raw}\n`);
      skipBlank = false;
      continue;
    }

    if (event.line === '') {
      if (skipBlank) {
        skipBlank = false;
        continue;
      }
      await writeWithBackpressure(res, '\n');
      continue;
    }

    await writeWithBackpressure(res, `${event.line}\n`);
    skipBlank = false;
  }

  if (!sawDone) await writeWithBackpressure(res, 'data: [DONE]\n\n');
}

/**
 * Relay an upstream SSE stream to the client.
 *
 * When the client requested the real upstream model id (the common case) the
 * bytes are piped straight through: no JSON parse/stringify per token, no
 * TextDecoder work beyond a bounded tail used for usage logging. Model-name
 * rewriting (aliases) takes the slower line-by-line path.
 */
export async function relayOpenAIStream({ body, res, requestedModel, upstreamModel, onUsage, onFirstChunk }) {
  const canPassthrough = !requestedModel || !upstreamModel || requestedModel === upstreamModel;
  if (canPassthrough) {
    return passthroughStream(body, res, { onUsage, onFirstChunk });
  }
  return rewriteStream(body, res, { requestedModel, onUsage, onFirstChunk });
}

/** Collect an upstream SSE stream into one OpenAI chat.completion object. */
export async function collectOpenAICompletion({ body, requestedModel, onFirstChunk }) {
  let id = null;
  let created = null;
  let model = null;
  let usage = null;
  let finishReason = null;
  let content = '';
  let reasoning = '';
  let first = true;
  const toolCalls = new Map();

  for await (const event of readSSE(body)) {
    const chunk = event.data;
    if (!chunk) continue;
    if (first) {
      first = false;
      if (onFirstChunk) onFirstChunk();
    }

    if (chunk.id) id = chunk.id;
    if (chunk.created) created = chunk.created;
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta || {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = call.index ?? 0;
        let current = toolCalls.get(index);
        if (!current) {
          current = { id: call.id || '', type: call.type || 'function', function: { name: '', arguments: '' } };
          toolCalls.set(index, current);
        }
        if (call.id) current.id = call.id;
        if (call.type) current.type = call.type;
        if (call.function?.name) current.function.name += call.function.name;
        if (call.function?.arguments) current.function.arguments += call.function.arguments;
      }
    }
  }

  const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  const message = { role: 'assistant', content: calls.length && !content ? null : content };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.length) message.tool_calls = calls;

  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model: requestedModel || model || 'unknown',
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason || (calls.length ? 'tool_calls' : 'stop')
      }
    ],
    usage
  };
}
