/**
 * Channel catalogue shown by the dashboard.
 *
 * `status: 'ready'` means the implementation exists in this repository.
 * `status: 'planned'` entries document the account-login channels from the
 * reference project (dsh-our-free-model) that are not wired yet — they need
 * their own OAuth flow / request signing and should be added as separate
 * modules under `src/channels/<name>/`.
 *
 * For provider presets:
 *   apiKeyRequired  — the chat endpoint rejects keyless requests.
 *   keyless         — verified against the live upstream: no account, no key.
 *   apiKeyUrl       — where the user creates a key (shown in the dashboard).
 */

export const CHANNEL_TYPES = [
  {
    type: 'workbuddy',
    label: 'WorkBuddy / CodeBuddy',
    status: 'ready',
    auth: '浏览器登录 / Token',
    description: '腾讯 WorkBuddy（CodeBuddy）账号渠道，支持多账号、会话粘滞与 429 冷却。'
  },
  {
    type: 'codebuddy',
    label: 'CodeBuddy（腾讯国内版）',
    status: 'ready',
    auth: '浏览器登录 / Token',
    description: 'copilot.tencent.com，与 WorkBuddy 同协议、不同端点与客户端标识。'
  },
  {
    type: 'openai-compatible',
    label: 'OpenAI 兼容',
    status: 'ready',
    auth: 'API Key / 免密',
    description: '任何提供 /chat/completions 与 /models 的上游，包括聚合网关与本机运行时。'
  },
  {
    type: 'qoder',
    label: 'Qoder',
    status: 'planned',
    auth: 'OAuth',
    description: '阿里系 Qoder / Qoder 中国版，需要专用授权与设备签名。'
  },
  {
    type: 'trae',
    label: 'TRAE',
    status: 'planned',
    auth: 'OAuth',
    description: '字节 TRAE，参考上游 channel-pack 的 trae-auth / trae-adapter。'
  },
  {
    type: 'cline',
    label: 'Cline',
    status: 'planned',
    auth: 'OAuth',
    description: 'Cline 账号池与速率限制，参考 cline-oauth / cline-rate-limit。'
  },
  {
    type: 'loomy',
    label: 'Loomy',
    status: 'planned',
    auth: 'OAuth / 微信',
    description: '讯飞 Loomy，包含微信登录与签名流程。'
  },
  {
    type: 'raccoon',
    label: 'Raccoon',
    status: 'planned',
    auth: '扫码登录',
    description: '商汤 Raccoon，二维码登录与专用产品头。'
  },
  {
    type: 'zcode',
    label: 'ZCode',
    status: 'planned',
    auth: '登录 / 验证码',
    description: '智谱 ZCode，含验证码与 Anthropic 线协议。'
  },
  {
    type: 'minimax',
    label: 'MiniMax Code',
    status: 'planned',
    auth: 'OAuth',
    description: 'MiniMax Code 账号渠道，参考 minimax-* 模块。'
  },
  {
    type: 'gemini-code-assist',
    label: 'Gemini Code Assist',
    status: 'planned',
    auth: 'Google OAuth',
    description: 'Google Code Assist，需要 OAuth 续期与项目探测。'
  },
  {
    type: 'codearts',
    label: 'CodeArts',
    status: 'planned',
    auth: '华为云账号',
    description: '华为云 CodeArts，含每日积分与直连抓取。'
  },
  {
    type: 'lobsterai',
    label: 'LobsterAI',
    status: 'planned',
    auth: 'OAuth',
    description: '有道 LobsterAI，参考 lobsterai-* 模块。'
  },
  {
    type: 'kilo',
    label: 'Kilo Gateway',
    status: 'ready',
    aliasType: 'openai-compatible',
    auth: 'API Key',
    description: 'Kilo 统一网关：需要登录 app.kilo.ai 创建 API Key。'
  },
  {
    type: 'opencode-zen',
    label: 'OpenCode Zen',
    status: 'ready',
    aliasType: 'openai-compatible',
    auth: 'API Key',
    description: 'OpenCode Zen 网关，需要 OpenCode 账号与 Key。'
  },
  {
    type: 'eac',
    label: 'EAC（桌面端）',
    status: 'planned',
    auth: '宿主凭据',
    description: '参考项目的桌面端协付通道，依赖宿主指纹与 GitHub 授权，不适用于独立服务。'
  }
];

/**
 * Presets for the generic OpenAI-compatible channel.
 *
 * Base URLs come from the reference project's provider registry. The
 * `apiKeyRequired` / `keyless` flags were checked against the live endpoints:
 * a keyless GET /models returning 200 does NOT mean keyless chat — NVIDIA and
 * Vercel publish their catalog publicly and still answer 401 on POST.
 * Only the local runtimes actually chat without a key. Kilo's gateway exposes
 * a public model list in some regions, but chat still needs an account key.
 */
export const PROVIDER_PRESETS = [
  {
    id: 'kilo',
    name: 'Kilo Gateway',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    apiKeyRequired: true,
    keyless: false,
    apiKeyUrl: 'https://app.kilo.ai/profile',
    note: '需要登录 app.kilo.ai 创建 API Key；匿名只可能访问少量免费模型，付费模型会返回 PAID_MODEL_AUTH_REQUIRED。',
    suggestedModels: ['kilo-auto/free', 'kilo-auto/efficient']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRequired: true,
    apiKeyUrl: 'https://openrouter.ai/keys',
    note: '需要注册并创建 Key。目录里有 :free 后缀的免费模型，但同样要账号与 Key。'
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyRequired: true,
    apiKeyUrl: 'https://console.groq.com/keys',
    note: '注册后可创建免费 Key，有速率限制。'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiKeyRequired: true,
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    note: '需要账号与余额，按量计费。'
  },
  {
    id: 'gemini',
    name: 'Gemini（OpenAI 兼容）',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyRequired: true,
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    note: '用 Google 账号在 AI Studio 创建 Key，有免费额度。'
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.com/v1',
    apiKeyRequired: true,
    apiKeyUrl: 'https://cloud.siliconflow.com/account/ak',
    note: '注册后可创建 Key，部分小模型免费。'
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyRequired: true,
    apiKeyUrl: 'https://build.nvidia.com/settings/api-keys',
    note: '模型列表公开可读，但对话必须带 Key；注册后有免费额度。'
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyRequired: true,
    apiKeyUrl: 'https://cloud.cerebras.ai',
    note: '注册后可创建 Key，有免费额度。'
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyRequired: true,
    apiKeyUrl: 'https://console.mistral.ai/',
    note: '注册后可创建 Key，有免费实验额度。'
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.ai/v1',
    apiKeyRequired: true,
    apiKeyUrl: 'https://api.together.ai/settings/api-keys',
    note: '注册后可创建 Key，部分模型免费。'
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyRequired: true,
    apiKeyUrl: 'https://fireworks.ai/account/api-keys',
    note: '注册后赠送额度，之后按量计费。'
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyRequired: true,
    apiKeyUrl: 'https://console.x.ai/team/default/api-keys',
    note: '需要账号与付费额度。'
  },
  {
    id: 'moonshot',
    name: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    apiKeyRequired: true,
    apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
    note: '注册后可创建 Key，部分模型有免费额度。'
  },
  {
    id: 'zai',
    name: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKeyRequired: true,
    apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
    note: '注册后可创建 Key。'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    apiKeyRequired: true,
    apiKeyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    note: '注册后可创建 Key。'
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiKeyRequired: true,
    apiKeyUrl: 'https://opencode.ai/auth',
    note: '需要 OpenCode 账号与 Key。'
  },
  {
    id: 'vercel',
    name: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    apiKeyRequired: true,
    apiKeyUrl: 'https://vercel.com/docs/ai-gateway',
    note: '模型列表公开可读，但对话必须带 Vercel 账号的 Key。'
  },
  {
    id: 'ollama',
    name: 'Ollama（本机）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKeyRequired: false,
    keyless: true,
    local: true,
    note: '本机运行时，无需账号与 Key；需要先在本机安装并拉取模型。'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本机）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKeyRequired: false,
    keyless: true,
    local: true,
    note: '本机运行时，在 LM Studio 里启动 Local Server 即可。'
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp（本机）',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKeyRequired: false,
    keyless: true,
    local: true,
    note: '本机 llama-server，无需账号与 Key。'
  }
];

export function presetById(id) {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) || null;
}
