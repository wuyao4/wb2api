import { randomUUID } from 'node:crypto';
import { readSSE } from './openai.js';

const STOP_REASON = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn'
};

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

function imagePart(block) {
  const source = block.source;
  if (!source) return null;
  if (source.type === 'base64' && source.data) {
    return { type: 'image_url', image_url: { url: `data:${source.media_type || 'image/png'};base64,${source.data}` } };
  }
  if (source.type === 'url' && source.url) {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

function toolResultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return textOf(block.content);
  if (block.content == null) return '';
  return JSON.stringify(block.content);
}

/** Convert an Anthropic /v1/messages request into an OpenAI chat request. */
export function anthropicToOpenAI(request) {
  const messages = [];

  const system = textOf(request.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const message of request.messages || []) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';

    if (typeof message.content === 'string') {
      messages.push({ role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) {
      messages.push({ role, content: '' });
      continue;
    }

    const parts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      switch (block.type) {
        case 'text':
          if (block.text) parts.push({ type: 'text', text: block.text });
          break;
        case 'image': {
          const image = imagePart(block);
          if (image) parts.push(image);
          break;
        }
        case 'tool_use':
          toolCalls.push({
            id: block.id || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'function',
            function: { name: block.name || '', arguments: JSON.stringify(block.input ?? {}) }
          });
          break;
        case 'tool_result':
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultText(block)
          });
          break;
        default:
          break;
      }
    }

    if (role === 'assistant') {
      if (toolCalls.length) {
        messages.push({ role: 'assistant', content: textOf(parts) || null, tool_calls: toolCalls });
      } else {
        messages.push({ role: 'assistant', content: textOf(parts) });
      }
      continue;
    }

    if (parts.length) {
      if (parts.length === 1 && parts[0].type === 'text') messages.push({ role: 'user', content: parts[0].text });
      else messages.push({ role: 'user', content: parts });
    }
    for (const result of toolResults) messages.push(result);
  }

  const body = { messages };
  if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.top_p !== undefined) body.top_p = request.top_p;
  if (request.top_k !== undefined) body.top_k = request.top_k;
  if (Array.isArray(request.stop_sequences) && request.stop_sequences.length) body.stop = request.stop_sequences;
  if (request.metadata) body.metadata = request.metadata;

  if (Array.isArray(request.tools) && request.tools.length) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema || { type: 'object', properties: {} }
      }
    }));
  }

  if (request.tool_choice) {
    const choice = request.tool_choice;
    if (choice.type === 'any') body.tool_choice = 'required';
    else if (choice.type === 'tool' && choice.name) body.tool_choice = { type: 'function', function: { name: choice.name } };
    else if (choice.type === 'none') body.tool_choice = 'none';
    else body.tool_choice = 'auto';
  }

  if (request.tool_choice?.disable_parallel_tool_use) body.parallel_tool_calls = false;

  return body;
}

function safeJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function messageId() {
  return `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Convert an OpenAI chat.completion into an Anthropic message. */
export function openAIToAnthropicMessage(completion, requestedModel) {
  const message = completion?.choices?.[0]?.message || { role: 'assistant', content: '' };
  const content = [];

  if (message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content, signature: '' });
  }
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  }
  for (const call of message.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: call.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name: call.function?.name || '',
      input: safeJson(call.function?.arguments)
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const usage = completion?.usage || {};
  return {
    id: completion?.id || messageId(),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: STOP_REASON[completion?.choices?.[0]?.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0
    }
  };
}

/** Translate an OpenAI SSE stream into Anthropic message events. */
export async function relayAnthropicStream({ body, res, requestedModel, onUsage }) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const id = messageId();

  send('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });

  let nextIndex = 0;
  let open = null;
  let finishReason = 'stop';
  let usage = null;

  const closeBlock = () => {
    if (!open) return;
    send('content_block_stop', { type: 'content_block_stop', index: open.index });
    open = null;
  };

  const startBlock = (type, contentBlock, toolIndex) => {
    closeBlock();
    open = { index: nextIndex++, type, toolIndex };
    send('content_block_start', { type: 'content_block_start', index: open.index, content_block: contentBlock });
  };

  for await (const event of readSSE(body)) {
    const chunk = event.data;
    if (!chunk) continue;
    if (chunk.usage) {
      usage = chunk.usage;
      if (onUsage) onUsage(chunk.usage);
    }

    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (!delta) continue;

    if (delta.reasoning_content) {
      if (!open || open.type !== 'thinking') startBlock('thinking', { type: 'thinking', thinking: '' });
      send('content_block_delta', {
        type: 'content_block_delta',
        index: open.index,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
      });
    }

    if (delta.content) {
      if (!open || open.type !== 'text') startBlock('text', { type: 'text', text: '' });
      send('content_block_delta', {
        type: 'content_block_delta',
        index: open.index,
        delta: { type: 'text_delta', text: delta.content }
      });
    }

    for (const call of delta.tool_calls || []) {
      const toolIndex = call.index ?? 0;
      if (!open || open.type !== 'tool_use' || open.toolIndex !== toolIndex) {
        startBlock(
          'tool_use',
          {
            type: 'tool_use',
            id: call.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
            name: call.function?.name || '',
            input: {}
          },
          toolIndex
        );
      }
      if (call.function?.arguments) {
        send('content_block_delta', {
          type: 'content_block_delta',
          index: open.index,
          delta: { type: 'input_json_delta', partial_json: call.function.arguments }
        });
      }
    }
  }

  closeBlock();
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: STOP_REASON[finishReason] || 'end_turn', stop_sequence: null },
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0
    }
  });
  send('message_stop', { type: 'message_stop' });
}

export function anthropicError(res, status, message, type = 'api_error') {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}
