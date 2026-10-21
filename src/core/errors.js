/** Errors shared by the HTTP layer, the channels and the protocol adapters. */

export class HttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = options.code ?? null;
    this.detail = options.detail ?? null;
  }
}

/** An upstream (channel-side) failure with as much envelope detail as we saw. */
export class UpstreamError extends Error {
  constructor({ status, code, message, requestId, display, raw } = {}) {
    super(message || `upstream request failed with status ${status ?? '?'}`);
    this.name = 'UpstreamError';
    this.status = status ?? 502;
    this.code = code ?? null;
    this.requestId = requestId ?? null;
    this.display = display ?? null;
    this.raw = raw ?? null;
  }
}
