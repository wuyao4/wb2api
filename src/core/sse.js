/**
 * SSE parsing and backpressure-aware writes.
 *
 * The proxy talks OpenAI SSE on the upstream side for every channel type, so
 * this module is deliberately protocol-agnostic: it yields raw events and lets
 * the OpenAI/Anthropic adapters decide what to do with them.
 */

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

/** Write to a Node response, waiting for `drain` when the socket is full. */
export async function writeWithBackpressure(res, data) {
  if (res.write(data)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('client disconnected'));
    };
    res.on('drain', onDrain);
    res.on('close', onClose);
  });
}
