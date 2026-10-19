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

function normalizeMessages(messages, config) {
  const out = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];

  // OpenAI's newer "developer" role means the same thing upstream expects as
  // "system"; WorkBuddy only recognises the first message when it is "system".
  for (const message of out) {
    if (message.role === 'developer') message.role = 'system';
  }

  if (config.prompt.injectWhenMissing && out[0]?.role !== 'system') {
    out.unshift({ role: 'system', content: config.prompt.system });
  }
  return out;
}

export function prepareChatBody(config, requestBody, upstreamModel) {
  const body = {
    model: upstreamModel,
    messages: normalizeMessages(requestBody.messages, config),
    // WorkBuddy only supports streaming; the proxy aggregates when the client
    // asked for a non-streaming response.
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
 * Parse an SSE byte stream into events.
 * Yields { line } for comments/blank lines, { data } for JSON payloads and
 * { done: true } for the [DONE] marker.
 */
export async function* readSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';

  function* parseLine(line) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        yield { done: true };
        return;
      }
      if (!payload) {
        yield { line: '' };
        return;
      }
      try {
        yield { data: JSON.parse(payload) };
      } catch {
        yield { raw: line };
      }
      return;
    }
    yield { line };
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      yield* parseLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.length) yield* parseLine(buffer);
}

/**
 * Relay an upstream SSE stream to the client, keeping the OpenAI wire format
 * and rewriting the model name back to what the client asked for.
 */
export async function relayOpenAIStream({ body, res, requestedModel, onUsage }) {
  let sawDone = false;
  let skipBlank = false;

  for await (const event of readSSE(body)) {
    if (event.done) {
      sawDone = true;
      res.write('data: [DONE]\n\n');
      continue;
    }

    if (event.data) {
      const chunk = event.data;
      if (requestedModel && chunk.model) chunk.model = requestedModel;
      if (chunk.usage && onUsage) onUsage(chunk.usage);
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      skipBlank = true;
      continue;
    }

    if (event.raw) {
      res.write(`${event.raw}\n`);
      skipBlank = false;
      continue;
    }

    if (event.line === '') {
      if (skipBlank) {
        skipBlank = false;
        continue;
      }
      res.write('\n');
      continue;
    }

    // Comments such as ": heartbeat" and any unknown fields.
    res.write(`${event.line}\n`);
    skipBlank = false;
  }

  if (!sawDone) res.write('data: [DONE]\n\n');
}

/** Collect an upstream SSE stream into one OpenAI chat.completion object. */
export async function collectOpenAICompletion({ body, requestedModel }) {
  let id = null;
  let created = null;
  let model = null;
  let usage = null;
  let finishReason = null;
  let content = '';
  let reasoning = '';
  const toolCalls = new Map();

  for await (const event of readSSE(body)) {
    const chunk = event.data;
    if (!chunk) continue;

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
