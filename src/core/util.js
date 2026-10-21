/** Small shared helpers that have no dependencies of their own. */

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Recursively merge plain objects; arrays and primitives replace. */
export function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isObject(value) && isObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason || new Error('aborted'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Join a base URL and a path without producing a double slash. */
export function joinUrl(base, pathname = '') {
  const left = String(base || '').replace(/\/+$/, '');
  const right = String(pathname || '');
  if (!right) return left;
  return `${left}/${right.replace(/^\/+/, '')}`;
}

export function clone(value) {
  return structuredClone(value);
}

/** Generate a short, URL-safe identifier usable as a channel id. */
export function slug(value, fallback = 'channel') {
  const text = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return text || fallback;
}
