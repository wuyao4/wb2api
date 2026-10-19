import { log, warn } from './logger.js';
import { ulid, uuid, traceId } from './ids.js';

const STATIC_MODELS = [
  ['default-model', 'Auto'],
  ['fast-model', 'Fast'],
  ['balanced-model', 'Balanced'],
  ['primary-model', 'Primary'],
  ['deepseek-v4.1-flash', 'Deepseek-V4.1-Flash'],
  ['deepseek-v4.1-flash-sg', 'Deepseek-V4.1-Flash'],
  ['hy4-preview', 'Hy4 preview'],
  ['hy3', 'Hy3'],
  ['step-5-preview', 'Step-5-Preview'],
  ['gpt-6-astra', 'GPT-6-Astra'],
  ['gpt-6.1-sol', 'GPT-6.1-Sol'],
  ['gpt-6-sol', 'GPT-6-Sol'],
  ['gpt-6-luna', 'GPT-6-Luna'],
  ['gpt-5.6-sol', 'GPT-5.6-Sol'],
  ['gpt-5.6-terra', 'GPT-5.6-Terra'],
  ['gpt-5.6-luna', 'GPT-5.6-Luna'],
  ['gpt-5.5', 'GPT-5.5'],
  ['gpt-5.4', 'GPT-5.4'],
  ['grok-4.7', 'Grok-4.7'],
  ['gemini-3.8-flash', 'Gemini-3.8-Flash'],
  ['gemini-3.5-flash', 'Gemini-3.5-Flash'],
  ['glm-5.3-flash', 'GLM-5.3-Flash'],
  ['glm-5.3', 'GLM-5.3'],
  ['glm-5.2', 'GLM-5.2'],
  ['kimi-k3', 'Kimi-K3'],
  ['kimi-k2.8-preview', 'Kimi-K2.8-Preview'],
  ['kimi-k2.6', 'Kimi-K2.6']
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

export class UpstreamError extends Error {
  constructor({ status, code, message, requestId, display, raw }) {
    super(message || `upstream request failed with status ${status}`);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.display = display;
    this.raw = raw;
  }
}

export function effectiveContextLength(model, config) {
  const settings = config.models?.contextWindow || {};
  const requested = Number(settings.overrides?.[model.id] ?? settings.default ?? 0);
  const max = Number(model.maxInputTokens || model.maxAllowedSize || 0);
  if (requested > 0) return max > 0 ? Math.min(requested, max) : requested;
  return Number(model.contextWindow?.defaultLength || max) || null;
}

export class WorkBuddyClient {
  #refreshing = null;
  #models = null;
  #modelsFetchedAt = 0;

  constructor(config, save) {
    this.config = config;
    this.save = save;
    this.semaphore = new Semaphore(config.upstream.maxConcurrency);
  }

  setConfig(config) {
    this.config = config;
    this.semaphore = new Semaphore(config.upstream.maxConcurrency);
    this.#models = null;
    this.#modelsFetchedAt = 0;
  }

  get upstream() {
    return this.config.upstream;
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
    log(`access token refreshed (expires in ${json.data.expiresIn ?? '?'}s)`);
  }

  async #postChat(body, { signal, conversationId } = {}) {
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
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async chat(body, options = {}) {
    await this.ensureToken();

    const retry = this.config.retry || {};
    const maxAttempts = Math.max(1, Number(retry.maxAttempts) || 1);
    const baseDelay = Number(retry.baseDelayMs) || 2500;
    const maxDelay = Number(retry.maxDelayMs) || 20000;
    const originalModel = body.model;
    const fallbackModels = this.config.models.fallback?.[originalModel] || [];
    let model = originalModel;
    let fallbackIndex = 0;
    let refreshed = false;

    for (let attempt = 1; ; attempt += 1) {
      await this.semaphore.acquire();
      let res;
      try {
        res = await this.#postChat({ ...body, model }, options);
      } catch (err) {
        this.semaphore.release();
        throw err;
      }

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.semaphore.release();
        await res.text().catch(() => '');
        warn('upstream returned 401, refreshing token');
        await this.refreshToken();
        attempt -= 1;
        continue;
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxAttempts) {
        const info = await this.#describeError(res);
        this.semaphore.release();
        const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
        warn(`upstream ${res.status} (${info.code ?? '-'} ${info.message}) on ${model}, retry ${attempt}/${maxAttempts - 1} in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      if (retryable && fallbackIndex < fallbackModels.length) {
        await res.text().catch(() => '');
        this.semaphore.release();
        model = fallbackModels[fallbackIndex++];
        attempt = 0;
        warn(`upstream busy, falling back to ${model}`);
        continue;
      }

      // The caller owns the semaphore slot from here and must release it once
      // the response body has been consumed.
      return { res, release: () => this.semaphore.release(), model };
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
      return STATIC_MODELS.map(([id, name]) => ({ id, name }));
    }
  }

  async modelInfo(modelId) {
    const models = await this.fetchModels();
    return models.find((m) => m.id === modelId) || null;
  }

  async listOpenAIModels() {
    const models = await this.fetchModels();
    const created = Math.floor(Date.now() / 1000);
    const out = models.map((m) => {
      const contextLength = effectiveContextLength(m, this.config);
      const maxContext = m.maxInputTokens ?? m.maxAllowedSize ?? contextLength;
      const supported = m.contextWindow?.supportedLengths?.filter((value) => value > 0) || (maxContext ? [maxContext] : []);
      return {
        id: m.id,
        object: 'model',
        created,
        owned_by: m.vendor ? `workbuddy/${m.vendor}` : 'workbuddy',
        name: m.name || m.id,
        context_length: contextLength,
        context_window: contextLength,
        max_context_length: maxContext,
        max_input_tokens: maxContext,
        supported_context_lengths: supported,
        default_context_length: m.contextWindow?.defaultLength ?? contextLength,
        max_output_tokens: m.maxOutputTokens,
        capabilities: {
          vision: !!m.supportsImages,
          tools: !!m.supportsToolCall,
          reasoning: !!(m.supportsReasoning || m.reasoning)
        }
      };
    });

    const known = new Set(out.map((m) => m.id));
    for (const [alias, target] of Object.entries(this.config.models.aliases || {})) {
      if (known.has(alias)) continue;
      const base = out.find((m) => m.id === target);
      out.push({
        id: alias,
        object: 'model',
        created,
        owned_by: 'workbuddy/alias',
        name: `${alias} -> ${target}`,
        context_length: base?.context_length,
        context_window: base?.context_window,
        max_context_length: base?.max_context_length,
        max_input_tokens: base?.max_input_tokens,
        supported_context_lengths: base?.supported_context_lengths,
        max_output_tokens: base?.max_output_tokens,
        root: target
      });
    }
    return out;
  }

  resolveModel(requested) {
    const id = String(requested || '').trim() || this.config.models.default;
    const aliases = this.config.models.aliases || {};
    if (aliases[id]) return aliases[id];
    return id;
  }
}
