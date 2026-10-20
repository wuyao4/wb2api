const MAX_LOGS = 80;

const stats = {
  startedAt: Date.now(),
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  errors: 0,
  lastRequestAt: null
};

const logs = [];

export function recordRequest(entry) {
  const record = {
    at: Date.now(),
    kind: entry.kind || 'chat',
    model: entry.model || '',
    upstreamModel: entry.upstreamModel || '',
    account: entry.account || '',
    stream: !!entry.stream,
    status: entry.status || 200,
    durationMs: entry.durationMs || 0,
    ttfbMs: entry.ttfbMs ?? null,
    promptTokens: entry.promptTokens ?? null,
    completionTokens: entry.completionTokens ?? null,
    error: entry.error || null
  };

  stats.requests += 1;
  stats.lastRequestAt = record.at;
  if (record.promptTokens) stats.promptTokens += record.promptTokens;
  if (record.completionTokens) stats.completionTokens += record.completionTokens;
  if (record.status >= 400 || record.error) stats.errors += 1;

  logs.unshift(record);
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
}

export function getStats() {
  return {
    ...stats,
    uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000)
  };
}

export function getLogs(limit = 50) {
  return logs.slice(0, limit);
}
