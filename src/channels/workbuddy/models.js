/** Static roster used when `/v3/config` is unreachable or not yet authenticated. */
export const STATIC_MODELS = [
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

export function staticModels() {
  return STATIC_MODELS.map(([id, name]) => ({ id, name }));
}

export function effectiveContextLength(model, channelConfig = {}) {
  const settings = channelConfig.models?.contextWindow || {};
  const requested = Number(settings.overrides?.[model.id] ?? settings.default ?? 0);
  const max = Number(model.maxInputTokens || model.maxAllowedSize || 0);
  if (requested > 0) return max > 0 ? Math.min(requested, max) : requested;
  return Number(model.contextWindow?.defaultLength || max) || null;
}

/** Shape an upstream WorkBuddy model row the way every client expects it. */
export function normalizeModel(model, channelConfig = {}) {
  const contextLength = effectiveContextLength(model, channelConfig);
  const maxContext = model.maxInputTokens ?? model.maxAllowedSize ?? contextLength;
  const supported =
    model.contextWindow?.supportedLengths?.filter((value) => value > 0) || (maxContext ? [maxContext] : []);

  return {
    id: model.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: model.vendor ? `workbuddy/${model.vendor}` : 'workbuddy',
    name: model.name || model.id,
    context_length: contextLength,
    context_window: contextLength,
    max_context_length: maxContext,
    max_input_tokens: maxContext,
    supported_context_lengths: supported,
    default_context_length: model.contextWindow?.defaultLength ?? contextLength,
    max_output_tokens: model.maxOutputTokens,
    capabilities: {
      vision: !!model.supportsImages,
      tools: !!model.supportsToolCall,
      reasoning: !!(model.supportsReasoning || model.reasoning)
    }
  };
}
