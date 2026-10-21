/**
 * WorkBuddy needs a per-account `config` object shaped like the original
 * single-channel config (`upstream` + `models` + `retry`). This module is the
 * only place that translation happens.
 */

export function clientConfigFor(channel, entry, retry = {}) {
  const options = channel.options || {};
  return {
    upstream: {
      ...options,
      accessToken: entry.accessToken || '',
      refreshToken: entry.refreshToken || '',
      deviceToken: entry.deviceToken || options.deviceToken || '',
      userId: entry.userId || '',
      maxConcurrency: Number(entry.maxConcurrency) || 1,
      enabled: entry.enabled !== false,
      label: entry.label || ''
    },
    models: channel.models || {},
    retry
  };
}

/** Headers used by the unauthenticated desktop-login handshake. */
export function pluginHeaders(channel, deviceToken = '') {
  const options = channel.options || {};
  const headers = {
    'X-No-Authorization': 'true',
    'X-Product': options.product || 'SaaS',
    'X-Domain': options.domain || 'www.workbuddy.ai',
    Accept: 'application/json',
    'User-Agent': options.client?.userAgent || 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0'
  };
  if (deviceToken) headers['X-Device-Token'] = deviceToken;
  return headers;
}

export function loginBaseUrl(channel) {
  const base = String(channel.options?.baseUrl || 'https://www.workbuddy.ai').replace(/\/+$/, '');
  let origin = 'https://www.workbuddy.ai';
  try {
    origin = new URL(base).origin;
  } catch {
    /* keep default */
  }
  return { base, origin };
}
