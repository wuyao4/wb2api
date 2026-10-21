import { HttpError } from '../core/errors.js';
import { warn } from '../core/logger.js';
import { WorkBuddyChannel } from './workbuddy/index.js';
import { OpenAICompatibleChannel } from './openai-compatible/index.js';
import { AccountChannel, ACCOUNT_CHANNEL_SPECS } from './account/index.js';

const DEFINITIONS = {
  workbuddy: {
    type: 'workbuddy',
    create: (context) => new WorkBuddyChannel(context)
  },
  // CodeBuddy speaks the same protocol as WorkBuddy (different endpoint and
  // platform id), so it reuses the runtime.
  codebuddy: {
    type: 'codebuddy',
    create: (context) => new WorkBuddyChannel(context)
  },
  'openai-compatible': {
    type: 'openai-compatible',
    create: (context) => new OpenAICompatibleChannel(context)
  },
  // Account-based OAuth channels (Cline, Qoder, Gemini Code Assist, TRAE,
  // Raccoon). They share one runtime and differ only by their spec.
  account: {
    type: 'account',
    create: (context) => {
      const spec = ACCOUNT_CHANNEL_SPECS[context.config.oauth || context.id];
      if (!spec) {
        warn(`account channel "${context.id}" has no spec, skipped`);
        return null;
      }
      return new AccountChannel({ ...context, spec });
    }
  }
};

export function channelDefinition(type) {
  return DEFINITIONS[type] || null;
}

export function supportedChannelTypes() {
  return Object.keys(DEFINITIONS);
}

/**
 * The registry owns model namespace resolution.
 *
 * - `channel/model` always wins when `channel` is a configured id.
 * - Bare ids are matched against every enabled channel (aliases included).
 * - Anything unknown is sent to the preferred channel, which preserves the
 *   pre-0.2 behaviour for clients that pass ids the gateway did not list.
 */
export class ChannelRegistry {
  constructor(config, { persist, retry }) {
    this.config = config;
    this.persist = persist;
    this.retry = retry;
    this.channels = [];
    this.byId = new Map();
    this.build();
  }

  build() {
    this.channels = [];
    this.byId = new Map();

    for (const [id, raw] of Object.entries(this.config.channels || {})) {
      const definition = channelDefinition(raw.type);
      if (!definition) {
        warn(`unknown channel type "${raw.type}" for channel "${id}", skipped`);
        continue;
      }
      const channel = definition.create({
        id,
        config: raw,
        appConfig: this.config,
        persist: this.persist
      });
      if (!channel) continue;
      this.channels.push(channel);
      this.byId.set(id, channel);
    }
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  enabledChannels() {
    return this.channels.filter((channel) => channel.enabled);
  }

  /** Preferred channel when an id is ambiguous; no model resolution involved. */
  preferredChannel() {
    const workbuddy = this.byId.get('workbuddy');
    if (workbuddy?.enabled) return workbuddy;
    return this.enabledChannels()[0] || this.channels[0] || null;
  }

  defaultChannel() {
    const configured = String(this.config.routing?.defaultModel || '');
    const slash = configured.indexOf('/');
    if (slash > 0) {
      const candidate = this.byId.get(configured.slice(0, slash));
      if (candidate?.enabled) return candidate;
    }
    return this.preferredChannel();
  }

  /**
   * Resolve a client-supplied model id to { channel, model, requestedId }.
   * `model` is the upstream model id inside that channel.
   */
  resolveModel(requestedId) {
    const raw = String(requestedId || '').trim();
    let id = raw || String(this.config.routing?.defaultModel || '');

    const aliases = this.config.routing?.aliases || {};
    for (let guard = 0; guard < 8 && aliases[id]; guard += 1) id = String(aliases[id]);

    const enabled = this.enabledChannels();
    if (!enabled.length) throw new HttpError(503, '没有启用的渠道，请先在控制台添加渠道');

    const slash = id.indexOf('/');
    if (slash > 0) {
      const channel = this.byId.get(id.slice(0, slash));
      if (channel?.enabled) {
        return {
          channel,
          model: channel.resolveModel(id.slice(slash + 1)),
          requestedId: raw || id
        };
      }
    }

    // Channel-level aliases and known model ids, regardless of namespace.
    const known = enabled.filter((channel) => channel.hasModel(id));
    if (known.length) {
      const preferred = this.defaultChannel();
      const channel = known.find((entry) => entry.id === preferred?.id) || known[0];
      return { channel, model: channel.resolveModel(id), requestedId: raw || id };
    }

    const preferred = this.defaultChannel();
    const fallback =
      preferred && preferred.config?.models?.allowUnknown !== false
        ? preferred
        : enabled.find((channel) => channel.config?.models?.allowUnknown !== false) || preferred || enabled[0];

    if (!fallback) throw new HttpError(503, '没有可用的渠道');
    return { channel: fallback, model: fallback.resolveModel(id), requestedId: raw || id };
  }

  /**
   * Aggregate the model list across channels.
   * `namespace: auto` exposes `channel/model` only when more than one channel
   * is enabled, which keeps single-channel clients byte-compatible.
   */
  async listModels({ force = false } = {}) {
    const enabled = this.enabledChannels();
    const routing = this.config.routing || {};
    const namespace =
      routing.namespace === 'always' || (routing.namespace !== 'never' && enabled.length > 1);

    const settled = await Promise.allSettled(enabled.map((channel) => channel.listModels({ force })));
    const perChannel = [];
    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        warn(`model list for ${enabled[index].id} failed: ${result.reason?.message || result.reason}`);
        return;
      }
      perChannel.push({ channel: enabled[index], models: result.value || [] });
    });

    const out = [];
    const seen = new Set();
    const bareCounts = new Map();

    const push = (entry) => {
      if (!entry?.id || seen.has(entry.id)) return;
      seen.add(entry.id);
      out.push(entry);
    };

    for (const { channel, models } of perChannel) {
      for (const model of models) {
        const upstreamId = String(model.id);
        bareCounts.set(upstreamId, (bareCounts.get(upstreamId) || 0) + 1);
        push({
          ...model,
          id: namespace ? `${channel.id}/${upstreamId}` : upstreamId,
          upstream_id: upstreamId,
          channel: channel.id,
          channel_label: channel.label,
          root: upstreamId,
          name: namespace ? `${channel.label} · ${model.name || upstreamId}` : model.name || upstreamId
        });
      }

      for (const [alias, target] of Object.entries(channel.aliases())) {
        const aliasId = namespace ? `${channel.id}/${alias}` : alias;
        push({
          id: aliasId,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: `${channel.id}/alias`,
          name: `${alias} → ${target}`,
          channel: channel.id,
          channel_label: channel.label,
          root: target,
          upstream_id: target
        });
      }
    }

    // Explicit global aliases (routing.aliases) are always exposed bare.
    for (const [alias, target] of Object.entries(routing.aliases || {})) {
      let resolved = null;
      try {
        resolved = this.resolveModel(target);
      } catch {
        /* target may point at a disabled channel */
      }
      push({
        id: alias,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'alias',
        name: `${alias} → ${target}`,
        channel: resolved?.channel?.id || '',
        channel_label: resolved?.channel?.label || '',
        root: target,
        upstream_id: resolved?.model || target
      });
    }

    // Optional compatibility rows: bare ids that are unique across channels.
    if (namespace && routing.exposeUnprefixed) {
      for (const entry of [...out]) {
        if (!entry.channel || !entry.upstream_id) continue;
        if (bareCounts.get(entry.upstream_id) !== 1) continue;
        push({ ...entry, id: entry.upstream_id, name: entry.name });
      }
    }

    return out;
  }

  statuses() {
    return this.channels.map((channel) => channel.status());
  }

  describes() {
    return this.channels.map((channel) => channel.describe());
  }
}
