import { UpstreamError } from '../../core/errors.js';
import { joinUrl, sleep } from '../../core/util.js';
import { warn } from '../../core/logger.js';

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
 * One OpenAI-compatible upstream credential slot.
 *
 * Covers aggregator gateways (OpenRouter, Groq, Kilo, DeepSeek, …) and local
 * runtimes (Ollama / LM Studio / llama.cpp). The wire is always Chat
 * Completions over SSE.
 */
export class OpenAICompatClient {
  #cooldownUntil = 0;
  #models = null;
  #modelsFetchedAt = 0;
  inflight = 0;

  constructor({ options, account, retry = {}, channelLabel = '' }) {
    this.options = options;
    this.account = account;
    this.retry = retry;
    this.channelLabel = channelLabel;
    this.semaphore = new Semaphore(account.maxConcurrency || options.maxConcurrency || 4);
  }

  get upstream() {
    return this.options;
  }

  get cooldownUntil() {
    return this.#cooldownUntil;
  }

  get cachedModels() {
    return this.#models;
  }

  get hasCredentials() {
    return true;
  }

  isCoolingDown() {
    return this.#cooldownUntil > Date.now();
  }

  tokenExpiresAt() {
    return 0;
  }

  #headers(accept) {
    const options = this.options;
    const headers = {
      Accept: accept,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    const key = String(this.account?.apiKey || options.apiKey || '').trim();
    if (key) {
      const header = options.apiKeyHeader || 'Authorization';
      const prefix = options.apiKeyPrefix === undefined ? 'Bearer ' : options.apiKeyPrefix;
      headers[header] = `${prefix}${key}`;
    }
    return headers;
  }

  #url(pathname) {
    if (!this.options.baseUrl) {
      throw new UpstreamError({ status: 400, message: `${this.channelLabel || '渠道'} 尚未配置 baseUrl` });
    }
    return joinUrl(this.options.baseUrl, pathname);
  }

  async #fetch(url, init, signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      controller.abort(new Error('upstream header timeout'));
    }, Number(this.options.headerTimeoutMs) || 120000);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
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
      code: json?.error?.code || json?.code,
      message: json?.error?.message || json?.msg || text.slice(0, 300),
      raw: text
    };
  }

  async chat(body, options = {}) {
    this.inflight += 1;

    const maxAttempts = Math.max(1, Number(this.retry.maxAttempts) || 1);
    const baseDelay = Number(this.retry.baseDelayMs) || 2500;
    const maxDelay = Number(this.retry.maxDelayMs) || 20000;
    const signal = options.signal;
    const originalModel = body.model;
    const fallbackModels = this.options.fallbacks?.[originalModel] || [];
    let model = originalModel;
    let fallbackIndex = 0;
    let payload = JSON.stringify({ ...body, model });

    for (let attempt = 1; ; attempt += 1) {
      await this.semaphore.acquire();
      let res;
      try {
        if (signal?.aborted) throw signal.reason || new Error('client disconnected');
        await this.#waitCooldown(signal);
        res = await this.#fetch(
          this.#url(this.options.chatPath || '/chat/completions'),
          {
            method: 'POST',
            headers: this.#headers('text/event-stream'),
            body: payload
          },
          signal
        );
      } catch (error) {
        this.semaphore.release();
        this.inflight = Math.max(0, this.inflight - 1);
        throw error;
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxAttempts) {
        const info = await this.#describeError(res);
        this.semaphore.release();
        const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
        if (res.status === 429) {
          this.#cooldownUntil = Math.max(this.#cooldownUntil, Date.now() + delay);
        }
        warn(
          `[${this.channelLabel}] upstream ${res.status} (${info.code ?? '-'} ${info.message}) on ${model}, retry ${attempt}/${maxAttempts - 1} in ${delay}ms`
        );
        try {
          await sleep(delay, signal);
        } catch (error) {
          this.inflight = Math.max(0, this.inflight - 1);
          throw error;
        }
        continue;
      }

      if (retryable && fallbackIndex < fallbackModels.length) {
        await res.text().catch(() => '');
        this.semaphore.release();
        model = fallbackModels[fallbackIndex++];
        payload = JSON.stringify({ ...body, model });
        attempt = 0;
        warn(`[${this.channelLabel}] upstream busy, falling back to ${model}`);
        continue;
      }

      if (res.status === 429) {
        const delay = Math.min(maxDelay, baseDelay * 2 ** Math.max(0, attempt - 1));
        this.#cooldownUntil = Math.max(this.#cooldownUntil, Date.now() + delay);
      }

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

  async fetchModels(force = false) {
    const ttl = (Number(this.options.cacheTtlSeconds) || 600) * 1000;
    if (!force && this.#models && Date.now() - this.#modelsFetchedAt < ttl) return this.#models;
    if (!this.options.baseUrl) throw new UpstreamError({ status: 400, message: 'missing baseUrl' });

    const res = await fetch(this.#url(this.options.modelsPath || '/models'), {
      headers: this.#headers('application/json'),
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      throw new UpstreamError({
        status: res.status,
        code: json?.error?.code || json?.code,
        message: json?.error?.message || json?.msg || text.slice(0, 300) || `models request failed (${res.status})`,
        raw: text
      });
    }

    const rows = Array.isArray(json)
      ? json
      : Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.models)
          ? json.models
          : [];

    this.#models = rows
      .map((row) => (typeof row === 'string' ? { id: row } : row))
      .filter((row) => row && row.id);
    this.#modelsFetchedAt = Date.now();
    return this.#models;
  }
}
