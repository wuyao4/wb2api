import { UpstreamError } from '../../core/errors.js';
import { ulid, uuid, traceId } from '../../core/ids.js';
import { log, warn } from '../../core/logger.js';
import { sleep } from '../../core/util.js';

function jwtExpiresAt(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return 0;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(json.exp) || 0;
  } catch {
    return 0;
  }
}

class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }
}

/**
 * One WorkBuddy account.
 *
 * `config` is synthesised per account by the channel:
 *   { upstream: {...options, credentials...}, models, retry }
 */
export class WorkBuddyClient {
  #refreshing = null;
  #cooldownUntil = 0;
  #models = null;
  #modelsFetchedAt = 0;
  inflight = 0;

  constructor(config, save) {
    this.config = config;
    this.save = save;
    this.semaphore = new Semaphore(config.upstream.maxConcurrency);
  }

  get inflightCount() {
    return this.inflight;
  }

  get cooldownUntil() {
    return this.#cooldownUntil;
  }

  get upstream() {
    return this.config.upstream;
  }

  get cachedModels() {
    return this.#models;
  }

  get hasCredentials() {
    return Boolean(this.upstream.accessToken || this.upstream.refreshToken);
  }

  isCoolingDown() {
    return this.#cooldownUntil > Date.now();
  }

  setConfig(config) {
    this.config = config;
    this.semaphore = new Semaphore(config.upstream.maxConcurrency);
    this.#models = null;
    this.#modelsFetchedAt = 0;
  }

  tokenExpiresAt() {
    return jwtExpiresAt(this.upstream.accessToken);
  }

  #baseHeaders() {
    const u = this.upstream;
    const c = u.client || {};
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: u.accessToken ? `Bearer ${u.accessToken}` : '',
      'X-Device-Token': u.deviceToken,
      'X-User-Id': u.userId,
      'X-Domain': u.domain,
      'X-Product': u.product,
      'User-Agent': c.userAgent,
      'X-IDE-Type': c.ideType,
      'X-IDE-Name': c.ideName,
      'X-IDE-Version': c.ideVersion,
      'x-codebuddy-request': c.codebuddyRequest,
      'X-Requested-With': 'XMLHttpRequest'
    };
    // Never send empty identity headers: the upstream treats a present but
    // empty X-Device-Token differently from an omitted one.
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null || value === '') delete headers[key];
    }
    return headers;
  }

  #chatHeaders(conversationId) {
    const requestId = ulid();
    const conversationRequestId = ulid();
    const trace = traceId();
    return {
      ...this.#baseHeaders(),
      'X-Conversation-ID': conversationId || uuid(),
      'X-Request-ID': requestId,
      'X-Conversation-Message-ID': requestId,
      'X-Conversation-Request-ID': conversationRequestId,
      'X-Root-Request-ID': conversationRequestId,
      'X-Agent-Intent': 'craft',
      'X-Agent-Purpose': 'conversation',
      'X-Agent-Type': 'main',
      'X-Private-Data': 'true',
      'x-stainless-arch': process.arch === 'x64' ? 'x64' : process.arch,
      'x-stainless-lang': 'js',
      'x-stainless-os': process.platform === 'win32' ? 'Windows' : process.platform,
      'x-stainless-package-version': '6.25.0',
      'x-stainless-retry-count': '0',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': process.version,
      traceparent: `00-${trace}-0000000000000001-01`,
      b3: `${trace}-0000000000000001-1`,
      'X-B3-TraceId': trace,
      'X-B3-ParentSpanId': '0000000000000001',
      'X-B3-SpanId': '0000000000000001',
      'X-B3-Sampled': '1',
      'X-Trace-ID': trace
    };
  }

  async ensureToken(force = false) {
    if (!this.upstream.refreshToken) return;
    const exp = this.tokenExpiresAt();
    const now = Math.floor(Date.now() / 1000);
    if (!force && exp && exp - now > this.upstream.refreshSkewSeconds) return;
    await this.refreshToken();
  }

  async refreshToken() {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#doRefreshToken().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #doRefreshToken() {
    const u = this.upstream;
    if (!u.refreshToken) throw new UpstreamError({ status: 401, message: 'no refresh token configured' });

    const headers = this.#baseHeaders();
    delete headers['X-Requested-With'];
    headers['X-Refresh-Token'] = u.refreshToken;
    headers['X-Auth-Refresh-Source'] = 'plugin';
    headers['X-Request-ID'] = uuid();

    const url = `${u.baseUrl.replace(/\/+$/, '')}/v2/plugin/auth/token/refresh`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(30000)
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (!res.ok || !json || json.code !== 0 || !json.data?.accessToken) {
      throw new UpstreamError({
        status: res.status,
        code: json?.code,
        message: json?.msg || `token refresh failed (${res.status})`,
        requestId: json?.requestId,
        display: json?.displayMsg,
        raw: text
      });
    }

    u.accessToken = json.data.accessToken;
    if (json.data.refreshToken) u.refreshToken = json.data.refreshToken;
    if (this.save) this.save(this.config);
    log(`[${u.label || 'workbuddy'}] access token refreshed (expires in ${json.data.expiresIn ?? '?'}s)`);
  }

  async #postChat(payload, { signal, conversationId } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      controller.abort(new Error('upstream header timeout'));
    }, this.upstream.headerTimeoutMs);

    try {
      return await fetch(`${this.upstream.baseUrl.replace(/\/+$/, '')}/v2/chat/completions`, {
        method: 'POST',
        headers: this.#chatHeaders(conversationId),
        body: payload,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #waitCooldown(signal) {
    for (;;) {
      const remaining = this.#cooldownUntil - Date.now();
      if (remaining <= 0) return;
      await sleep(remaining, signal);
    }
  }

  async chat(body, options = {}) {
    await this.ensureToken();
    this.inflight += 1;

    const retry = this.config.retry || {};
    const maxAttempts = Math.max(1, Number(retry.maxAttempts) || 1);
    const baseDelay = Number(retry.baseDelayMs) || 2500;
    const maxDelay = Number(retry.maxDelayMs) || 20000;
    const signal = options.signal;
    const originalModel = body.model;
    const fallbackModels = this.config.models.fallback?.[originalModel] || [];
    let model = originalModel;
    let fallbackIndex = 0;
    let refreshed = false;
    let payload = JSON.stringify({ ...body, model });

    for (let attempt = 1; ; attempt += 1) {
      await this.semaphore.acquire();
      let res;
      try {
        if (signal?.aborted) throw signal.reason || new Error('client disconnected');
        await this.#waitCooldown(signal);
        res = await this.#postChat(payload, options);
      } catch (err) {
        this.semaphore.release();
        this.inflight = Math.max(0, this.inflight - 1);
        throw err;
      }

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.semaphore.release();
        await res.text().catch(() => '');
        warn('upstream returned 401, refreshing token');
        try {
          await this.refreshToken();
        } catch (err) {
          this.inflight = Math.max(0, this.inflight - 1);
          throw err;
        }
        attempt -= 1;
        continue;
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxAttempts) {
        const info = await this.#describeError(res);
        this.semaphore.release();
        const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
        if (res.status === 429) {
          // A shared cooldown stops queued requests from immediately walking
          // into the same upstream rate limit.
          this.#cooldownUntil = Math.max(this.#cooldownUntil, Date.now() + delay);
        }
        warn(
          `upstream ${res.status} (${info.code ?? '-'} ${info.message}) on ${model}, retry ${attempt}/${maxAttempts - 1} in ${delay}ms`
        );
        try {
          await sleep(delay, signal);
        } catch (err) {
          this.inflight = Math.max(0, this.inflight - 1);
          throw err;
        }
        continue;
      }

      if (retryable && fallbackIndex < fallbackModels.length) {
        await res.text().catch(() => '');
        this.semaphore.release();
        model = fallbackModels[fallbackIndex++];
        payload = JSON.stringify({ ...body, model });
        attempt = 0;
        warn(`upstream busy, falling back to ${model}`);
        continue;
      }

      if (res.status === 429) {
        const delay = Math.min(maxDelay, baseDelay * 2 ** Math.max(0, attempt - 1));
        this.#cooldownUntil = Math.max(this.#cooldownUntil, Date.now() + delay);
      }

      // The caller owns the semaphore slot from here and must release it once
      // the response body has been consumed.
      let released = false;
      return {
        res,
        model,
        release: () => {
          if (released) return;
          released = true;
          this.semaphore.release();
          this.inflight = Math.max(0, this.inflight - 1);
        }
      };
    }
  }

  async #describeError(res) {
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return {
      status: res.status,
      code: json?.code,
      message: json?.msg || text.slice(0, 300),
      requestId: json?.requestId,
      display: json?.displayMsg,
      raw: text
    };
  }

  async fetchProductConfigStrict() {
    await this.ensureToken();
    const res = await fetch(`${this.upstream.baseUrl.replace(/\/+$/, '')}/v3/config`, {
      method: 'GET',
      headers: { ...this.#baseHeaders(), 'X-Requested-With': 'XMLHttpRequest' },
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (!res.ok || json?.code !== 0 || !json?.data) {
      throw new UpstreamError({
        status: res.status,
        code: json?.code,
        message: json?.msg || text.slice(0, 300) || `config request failed (${res.status})`,
        requestId: json?.requestId,
        display: json?.displayMsg,
        raw: text
      });
    }
    return json.data;
  }

  async fetchModels(force = false) {
    const ttl = (this.config.models.cacheTtlSeconds || 600) * 1000;
    if (!force && this.#models && Date.now() - this.#modelsFetchedAt < ttl) return this.#models;

    try {
      const data = await this.fetchProductConfigStrict();
      if (!Array.isArray(data.models)) throw new Error('unexpected /v3/config response');
      this.#models = data.models;
      this.#modelsFetchedAt = Date.now();
      return this.#models;
    } catch (err) {
      warn(`failed to load model list: ${err.message}`);
      if (this.#models) return this.#models;
      throw err;
    }
  }

  async modelInfo(modelId) {
    const models = await this.fetchModels();
    return models.find((m) => m.id === modelId) || null;
  }
}
