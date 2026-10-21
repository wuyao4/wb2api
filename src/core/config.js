import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelsFromLegacy, normalizeChannelConfig } from '../channels/defaults.js';
import { deepMerge, isObject } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONFIG_PATH = process.env.WB2API_CONFIG
  ? path.resolve(process.env.WB2API_CONFIG)
  : path.join(ROOT, 'config.json');

export const CONFIG_VERSION = 2;

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  server: {
    host: '127.0.0.1',
    port: 8787,
    // Empty array = no local authentication (only do this on a trusted machine).
    apiKeys: ['sk-wb2api-local'],
    // When empty, /admin/* only accepts requests from localhost.
    adminToken: '',
    // The proxy answers /v1 requests only after it is started from the dashboard.
    running: false,
    requestBodyLimitMb: 128
  },
  /*
   * Global model routing. `defaultModel` may be `channel/model` or a bare
   * model id; bare ids are resolved against the enabled channels.
   * namespace: auto | always | never — whether /v1/models exposes `channel/model`.
   */
  routing: {
    defaultModel: 'workbuddy/deepseek-v4.1-flash',
    aliases: {},
    namespace: 'auto',
    exposeUnprefixed: false
  },
  channels: {
    workbuddy: normalizeChannelConfig('workbuddy', {})
  },
  prompt: {
    // Some upstreams (WorkBuddy) reject requests whose first message is not a
    // system prompt. Channels that do not care simply ignore this block.
    system: 'You are a helpful assistant.',
    injectWhenMissing: true
  },
  retry: {
    maxAttempts: 3,
    baseDelayMs: 2500,
    maxDelayMs: 20000
  },
  logging: {
    requests: true
  }
};

function applyLegacyShape(fileConfig) {
  // Version 1 had no `channels`; migrate it on read. The migrated shape is
  // written back on the next save, so the old fields are never required again.
  if (fileConfig.channels && typeof fileConfig.channels === 'object') return fileConfig;
  if (!fileConfig.upstream && !fileConfig.accounts && !fileConfig.models) return fileConfig;

  const migrated = channelsFromLegacy(fileConfig);
  return {
    ...fileConfig,
    version: CONFIG_VERSION,
    channels: migrated.channels,
    // Account routing moved into the channel; only the global default model
    // belongs at the top level.
    routing: {
      defaultModel: migrated.routing.defaultModel
    }
  };
}

function normalizeChannels(channels = {}) {
  const out = {};
  for (const [id, raw] of Object.entries(channels)) {
    if (!raw || typeof raw !== 'object') continue;
    out[id] = normalizeChannelConfig(id, raw);
  }
  return out;
}

function buildConfig(fileConfig = {}) {
  const source = applyLegacyShape(fileConfig);
  // An explicit `channels: {}` means "no channels"; only a missing key falls
  // back to the built-in WorkBuddy channel.
  const hasChannels = Object.prototype.hasOwnProperty.call(source, 'channels') && isObject(source.channels);

  const config = {
    version: CONFIG_VERSION,
    server: deepMerge(DEFAULT_CONFIG.server, source.server || {}),
    routing: deepMerge(DEFAULT_CONFIG.routing, source.routing || {}),
    // When a config file explicitly lists channels, respect that list. Only a
    // brand-new config gets the default WorkBuddy channel.
    channels: normalizeChannels(hasChannels ? source.channels : DEFAULT_CONFIG.channels),
    prompt: deepMerge(DEFAULT_CONFIG.prompt, source.prompt || {}),
    retry: deepMerge(DEFAULT_CONFIG.retry, source.retry || {}),
    logging: deepMerge(DEFAULT_CONFIG.logging, source.logging || {})
  };

  if (!config.routing.defaultModel) config.routing.defaultModel = DEFAULT_CONFIG.routing.defaultModel;
  return config;
}

function applyEnvOverrides(config) {
  const env = process.env;
  if (env.WB2API_HOST) config.server.host = env.WB2API_HOST;
  if (env.PORT) config.server.port = Number(env.PORT);
  if (env.WB2API_API_KEYS !== undefined) {
    config.server.apiKeys = env.WB2API_API_KEYS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (env.WB2API_DEFAULT_MODEL) config.routing.defaultModel = env.WB2API_DEFAULT_MODEL;
  if (env.WB2API_SYSTEM_PROMPT) config.prompt.system = env.WB2API_SYSTEM_PROMPT;

  // Legacy credential environment variables still target the WorkBuddy channel.
  const workbuddy = config.channels.workbuddy;
  if (workbuddy) {
    const primary = workbuddy.accounts.find((account) => account.id === 'primary') || workbuddy.accounts[0];
    if (primary) {
      if (env.WB2API_ACCESS_TOKEN) primary.accessToken = env.WB2API_ACCESS_TOKEN;
      if (env.WB2API_REFRESH_TOKEN) primary.refreshToken = env.WB2API_REFRESH_TOKEN;
      if (env.WB2API_DEVICE_TOKEN) primary.deviceToken = env.WB2API_DEVICE_TOKEN;
      if (env.WB2API_USER_ID) primary.userId = env.WB2API_USER_ID;
    }
    if (env.WB2API_BASE_URL) workbuddy.options.baseUrl = env.WB2API_BASE_URL;
  }

  return config;
}

export function loadConfig(file = CONFIG_PATH) {
  let fileConfig = {};
  let legacy = false;

  if (fs.existsSync(file)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse ${file}: ${err.message}`);
    }
    legacy = !fileConfig.channels && Boolean(fileConfig.upstream);
  }

  const config = applyEnvOverrides(buildConfig(fileConfig));
  Object.defineProperty(config, '__migratedFromLegacy', {
    value: legacy,
    enumerable: false,
    configurable: true
  });
  return config;
}

export function saveConfig(config, file = CONFIG_PATH) {
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}


