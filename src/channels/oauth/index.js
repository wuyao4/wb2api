import { HttpError } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import { ClineOAuth } from './cline.js';
import { GeminiCodeAssistOAuth } from './gemini.js';
import { LobsteraiOAuth } from './lobsterai.js';
import { LoomyOAuth } from './loomy.js';
import { MinimaxOAuth } from './minimax.js';
import { OpenRouterOAuth } from './openrouter.js';
import { QoderOAuth } from './qoder.js';
import { RaccoonOAuth } from './raccoon.js';
import { TraeOAuth } from './trae.js';
import { ZcodeOAuth } from './zcode.js';

/**
 * OAuth provider registry.
 *
 * Only providers with a documented, app-facing authorization flow live here.
 * Each entry declares its `kind`:
 *
 *   'device-code' — no listening port; show a code and poll
 *                   (OpenRouter uses loopback, Cline/Qoder/ZCode/MiniMax use this)
 *   'loopback'    — provider redirects to 127.0.0.1 (OpenRouter, Gemini, TRAE,
 *                   Raccoon, LobsterAI)
 *   'qr'          — the host renders a QR and polls (Raccoon)
 *   'sms'         — phone + SMS code, rendered as a form (Loomy)
 *
 * Providers without such a flow must NOT be added here. Their dashboards are
 * ordinary web apps behind a login wall (measured: all 15 key pages redirect to
 * a sign-in form); automating them would require holding the user's account
 * session and breaks on every UI change. Those go through the `open-key`
 * strategy instead: open the official page, then verify the pasted or
 * clipboard-captured key with a real one-token request.
 */
export class OAuthRegistry {
  constructor({ persist }) {
    this.providers = new Map();
    const register = (provider) => this.providers.set(provider.id, provider);

    register(new OpenRouterOAuth({ persist }));
    register(new ClineOAuth({ persist }));
    register(new QoderOAuth({ persist }));
    register(new GeminiCodeAssistOAuth({ persist }));
    register(new TraeOAuth({ persist }));
    register(new RaccoonOAuth({ persist }));
    register(new ZcodeOAuth({ persist }));
    register(new MinimaxOAuth({ persist }));
    register(new LoomyOAuth({ persist }));
    register(new LobsteraiOAuth({ persist }));
  }

  get(id) {
    return this.providers.get(id) || null;
  }

  has(id) {
    return this.providers.has(id);
  }

  /** Metadata for the dashboard: which providers can do a one-click login. */
  describe() {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      available: provider.available !== false,
      needsInput: typeof provider.submitCode === 'function'
    }));
  }

  async start(id, options) {
    const provider = this.get(id);
    if (!provider) throw new HttpError(400, `没有 ${id} 的官方授权流程`);
    return provider.start(options);
  }

  poll(id, state) {
    const provider = this.get(id);
    if (!provider) throw new HttpError(400, `没有 ${id} 的官方授权流程`);
    return provider.poll(state);
  }

  /** Providers that need a second user input (Loomy's SMS code). */
  async submit(id, state, code) {
    const provider = this.get(id);
    if (!provider?.submitCode) throw new HttpError(400, `${id} 不需要额外输入`);
    return provider.submitCode(state, code);
  }

  async refresh(id, credential) {
    const provider = this.get(id);
    if (!provider?.refresh) throw new HttpError(400, `${id} 不支持续期`);
    return provider.refresh(credential);
  }

  close() {
    for (const provider of this.providers.values()) provider.close?.();
    log('oauth providers closed');
  }
}
