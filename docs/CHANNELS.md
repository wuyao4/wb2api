# 渠道扩展指南

本文说明如何给 Buddy2API 增加一个新的上游渠道。目标不是“再写一个 if 分支”，
而是让每个渠道拥有独立的 **配置结构 / 认证流程 / 上游传输 / 模型清单**，
主程序只依赖一层很薄的渠道契约。

参考项目 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)
把账号渠道拆成 `*-auth`、`*-adapter`、`*-models`、`*-credits` 等模块；
本项目采用同样的分层，但保持零依赖、可直接用 Node 运行。

---

## 1. 模块边界

```
src/
  core/                    与渠道无关的基础设施
    config.js              配置读取、迁移、环境变量
    pool.js                通用账号池（会话粘滞 / 冷却 / 故障转移）
    http.js, sse.js, store.js, credentials.js, errors.js, util.js
  channels/
    defaults.js            每个 type 的默认配置 + 账号规范化
    registry.js            type -> 工厂函数；模型命名空间解析
    catalog.js             控制台展示的类型与预设
    <channel>/
      index.js             渠道运行时（契约实现）
      client.js            上游传输（HTTP / SSE / 刷新）
      *.js                 该渠道独有的认证、签名、模型解析
  protocol/
    openai.js              OpenAI 线协议（所有渠道的上游统一走 Chat Completions SSE）
    anthropic.js           Anthropic 线协议（客户端侧）
  serving/chat.js          /v1/chat/completions 与 /v1/messages 的统一管线
```

一个渠道只负责三件事：

1. **怎么拿到可用的上游连接**（认证、刷新、账号池）；
2. **上游模型清单长什么样**；
3. **怎么把一个 OpenAI Chat Completions 请求发出去并拿回 SSE**。

协议转换、鉴权、日志、统计、模型聚合、命名空间、控制台都由内核统一处理。

---

## 2. 渠道运行时契约

`ChannelRegistry` 通过 `definition.create(context)` 创建实例。`context` 为：

```js
{
  id,          // 渠道实例 id（config.channels 的 key），也是模型前缀
  config,      // 该渠道的规范化配置
  appConfig,   // 全局配置（prompt / retry / server / routing）
  persist      // () => void，保存整份配置
}
```

实例至少实现以下成员：

| 成员 | 必需 | 说明 |
| --- | --- | --- |
| `id` / `type` / `label` / `enabled` | 是 | 基础标识 |
| `capabilities` | 是 | `{ login, manualCredentials, oauth, multipleAccounts }` |
| `listModels({ force })` | 是 | 返回规范化模型数组（见第 4 节） |
| `resolveModel(id)` | 是 | 客户端模型 id -> 上游模型 id（处理别名） |
| `hasModel(id)` | 是 | 同步判断模型是否存在，用于裸 id 消歧 |
| `prepareRequest(body, model)` | 是 | 组装上游请求体（通常调用 `prepareChatBody` / `prepareCompatBody`） |
| `chat({ body, options, sessionKey })` | 是 | 返回 `{ res, release, model, account }`，`res` 是 fetch Response |
| `status()` | 是 | 控制台状态（账号、用户、token、模型设置、路由） |
| `describe()` | 是 | 控制台渠道详情（必须隐藏密钥） |
| `validate()` | 是 | `/admin/start` 前的可用性校验，返回 `{ ok, error? }` |
| `sessionKey(headers, body)` | 否 | 默认使用 `core/pool.js` 的 `sessionKeyFrom` |
| `modelInfo(id)` | 否 | 用于校验上下文窗口 override |
| `loginStart()` / `loginStatus()` | 否 | 浏览器登录 |
| `applyCredentials(source, overrides)` | 否 | 手动 Token / Key 写入 |
| `refreshAccount(accountId)` | 否 | 手动刷新 |
| `updateAccount` / `toggleAccount` / `removeAccount` | 否 | 账号管理 |

`chat()` 返回的 `res` 必须是一个 **OpenAI Chat Completions SSE** 响应；
`release()` 必须幂等，并在响应体读完后释放该账号的并发槽位。

---

## 3. 配置与注册

### 3.1 增加类型默认值

在 `src/channels/defaults.js` 的 `channelDefaults(type)` 中增加分支：

```js
if (type === 'my-channel') {
  return {
    type: 'my-channel',
    enabled: true,
    label: 'My Channel',
    options: {
      baseUrl: 'https://api.example.com',
      headerTimeoutMs: 120000
    },
    models: {
      aliases: {},
      fallback: {},
      allowUnknown: true,
      cacheTtlSeconds: 600,
      contextWindow: { default: 0, overrides: {} }
    },
    routing: { sessionAffinity: true, failover: true },
    accounts: []
  };
}
```

同时在 `normalizeChannelConfig()` 里补齐账号字段（token / apiKey / deviceId 等）。
账号 id 为 `primary` 的条目是主账号；控制台的登录/凭据默认作用于它。

### 3.2 注册工厂

```js
// src/channels/registry.js
import { MyChannel } from './my-channel/index.js';

const DEFINITIONS = {
  workbuddy: { ... },
  'openai-compatible': { ... },
  'my-channel': {
    type: 'my-channel',
    create: (context) => new MyChannel(context)
  }
};
```

### 3.3 控制台展示

在 `src/channels/catalog.js` 的 `CHANNEL_TYPES` 增加条目：

```js
{
  type: 'my-channel',
  label: 'My Channel',
  status: 'ready',
  auth: 'OAuth',
  description: '一句话说明'
}
```

`status: 'planned'` 的条目会出现在「添加渠道」类型说明里，但创建时会明确拒绝。

---

## 4. 模型规范化

`listModels()` 返回的每一项至少包含：

```js
{
  id: 'upstream-model-id',       // 上游真实 id
  object: 'model',
  name: 'Display Name',
  context_length: 128000,         // 可选
  max_context_length: 128000,     // 可选
  max_output_tokens: 8192,        // 可选
  supported_context_lengths: [],  // 可选
  capabilities: { vision: false, tools: true, reasoning: false }
}
```

内核会自动补充：

- `channel` / `channel_label`
- 多渠道时的 `id = "channel/upstream-id"`
- `upstream_id` / `root`
- 渠道别名（来自 `config.models.aliases`）与全局别名（`appConfig.routing.aliases`）

如果上游没有模型列表接口，使用 `config.options.models` 作为静态清单即可。
`allowUnknown: true` 让未知 id 也能透传到默认渠道。

---

## 5. 最小实现骨架

```js
// src/channels/my-channel/index.js
import { AccountPool, sessionKeyFrom } from '../../core/pool.js';
import { HttpError } from '../../core/errors.js';
import { prepareCompatBody } from '../../protocol/openai.js';
import { MyClient } from './client.js';

export class MyChannel {
  constructor({ id, config, appConfig, persist }) {
    this.id = id;
    this.config = config;
    this.appConfig = appConfig;
    this.persist = persist;
    this.cachedModels = [];
    this.pool = new AccountPool({
      entries: config.accounts,
      routing: config.routing,
      label: config.label || id,
      createClient: (entry) =>
        new MyClient({
          options: config.options,
          account: entry,
          retry: appConfig.retry,
          onTokens: (tokens) => {
            Object.assign(entry, tokens);
            this.persist();
          }
        })
    });
  }

  get type() { return 'my-channel'; }
  get label() { return this.config.label || this.id; }
  get enabled() { return this.config.enabled !== false; }
  get capabilities() {
    return { login: false, manualCredentials: true, oauth: false, multipleAccounts: true };
  }

  setConfig(config, appConfig = this.appConfig) {
    this.config = config;
    this.appConfig = appConfig;
    this.pool.setRouting(config.routing);
    this.pool.setEntries(config.accounts);
  }

  setEnabled(enabled) { this.config.enabled = Boolean(enabled); }

  async listModels({ force = false } = {}) {
    const rows = await this.pool.all()[0]?.client.listModels(force);
    this.cachedModels = rows || [];
    return this.cachedModels.map((row) => ({
      id: row.id,
      object: 'model',
      name: row.name || row.id,
      capabilities: { vision: false, tools: true, reasoning: false }
    }));
  }

  resolveModel(id) { return this.config.models.aliases?.[id] || String(id || ''); }
  hasModel(id) { return this.cachedModels.some((row) => row.id === id); }
  prepareRequest(body, model) { return prepareCompatBody(body, model, this.config.options); }

  async chat({ body, options, sessionKey }) {
    return this.pool.chat(body, options, sessionKey);
  }

  sessionKey(headers, body) { return sessionKeyFrom(headers, body); }

  status() { /* 参考 WorkBuddyChannel.status */ }
  describe() { /* 参考 WorkBuddyChannel.describe；不要泄露密钥 */ }
  async validate() {
    if (!this.config.options.baseUrl) return { ok: false, error: '缺少 baseUrl' };
    return { ok: true };
  }

  updateAccount({ id, label, maxConcurrency, enabled } = {}) {
    const entry = this.config.accounts.find((account) => account.id === id);
    if (!entry) throw new HttpError(404, '账号不存在');
    if (label) entry.label = label;
    if (maxConcurrency) entry.maxConcurrency = Number(maxConcurrency);
    if (enabled !== undefined) entry.enabled = Boolean(enabled);
    this.persist();
    this.pool.setEntries(this.config.accounts);
    return this.status();
  }

  toggleAccount({ id, enabled }) { return this.updateAccount({ id, enabled }); }
}
```

`MyClient` 需要提供：

```js
{
  chat(body, { signal }) -> { res, model, release },
  inflightCount,
  isCoolingDown(),
  cooldownUntil,
  fetchModels(force)
}
```

通用重试、429 冷却、并发信号量与 SSE 处理可以直接参考
`src/channels/openai-compatible/client.js`；需要 Token 刷新的渠道参考
`src/channels/workbuddy/client.js`。

---

## 6. 认证流程建议

账号型渠道（Qoder / TRAE / Cline / Loomy / Raccoon / ZCode / MiniMax / Gemini Code Assist /
CodeArts / LobsterAI）通常需要：

1. **登录会话创建**：`start()` 返回 `state` 与授权入口；
2. **轮询**：`poll({ state })` 返回 `pending` 或 `success`；
3. **凭据落盘**：只写 `config.channels.<id>.accounts[]`，敏感字段不要出现在 `status()`/`describe()`；
4. **刷新单飞**：同一个账号同一时刻只允许一个刷新请求；
5. **账号池**：登录成功后可追加新账号，或按用户 id 更新已有账号。

### 已实现：十个官方授权渠道

`src/channels/oauth/` 下已有十个可参考的完整实现：

| 渠道 | 文件 | 形态 |
| --- | --- | --- |
| OpenRouter | `openrouter.js` | OAuth PKCE + localhost 回调 |
| Cline | `cline.js` | WorkOS device-code（无端口） |
| Qoder | `qoder.js` | PKCE device-code（无端口，404 = 待授权） |
| Gemini Code Assist | `gemini.js` | Google OAuth + PKCE + 回调 |
| TRAE | `trae.js` | PKCE + 固定端口回调（占用则回退） |
| Raccoon | `raccoon.js` | 微信扫码 + 宿主轮询（无回调） |

新增同类渠道时继承 `OAuthProvider`（`base.js`），实现 `start()` / `poll()`，
注册到 `OAuthRegistry`，再把 `CONNECT_META` 的策略改成 `'oauth'`，控制台就会自动显示「一键授权」。
如果 token 的传输方式与 OpenAI 兼容不同，在 `src/channels/account/index.js` 的
`ACCOUNT_CHANNEL_SPECS` 加一条 spec（base URL、路径、额外头、兜底模型）。

**不要**用无头浏览器自动化厂商的登录页面：那会违反条款，且必然被 CSRF、
验证码与 Cloudflare 拦住（实测 16 个 Key 页面全部需要登录）；
同时也意味着要经手用户的账号会话。
没有官方授权 API 的渠道，一律用 `open-key` 策略（打开官方页 + 校验粘贴/剪贴板捕获的 Key）。

参考项目中的对应模块：

| 渠道 | 可参考的模块（vendor/channel-pack/src/） | 本项目状态 |
| --- | --- | --- |
| Cline | `cline-oauth.ts`、`cline-adapter.ts` | **已实现**（`oauth/cline.js`） |
| Qoder / Qoder CN | `qoder-oauth.ts`、`qoder-adapter.ts` | **已实现**（`oauth/qoder.js`） |
| Gemini Code Assist | `gemini-oauth.ts`、`gemini-adapter.ts` | **已实现**（`oauth/gemini.js`） |
| TRAE | `trae-oauth.ts`、`trae-adapter.ts` | **已实现**（`oauth/trae.js`） |
| Raccoon | `raccoon-oauth.ts`、`raccoon-qr.ts` | **已实现**（`oauth/raccoon.js`） |
| ZCode | `zcode-login.ts`、`zcode-auth.ts` | **已实现**（`oauth/zcode.js`） |
| MiniMax Code | `minimax-oauth.ts` | **已实现**（`oauth/minimax.js`） |
| Loomy | `loomy-oauth.ts`、`loomy-sign.ts` | **已实现**（`oauth/loomy.js`） |
| LobsterAI | `lobsterai-oauth.ts` | **已实现**（`oauth/lobsterai.js`） |
| CodeBuddy | `product.ts`（`CODEBUDDY`） | **已实现**（复用 WorkBuddy 运行时） |
| CodeArts | `codearts-credits.ts`、`direct-fetch.ts` | 待移植（专有 HMAC + 积分） |
| OpenCode | `opencode-auth.ts`、`opencode.ts` | 不支持（免费层拒绝第三方客户端） |
| Kilo（API Key） | `src/kilo.js` | 已用 `openai-compatible` 预设覆盖 |

移植时建议只取 **认证 + 上游请求** 两部分，把模型列表转换为本项目的模型结构；
不要引入参考项目的 DSH 内核依赖、积分体系或 UI。

---

## 7. 接入检查清单

- [ ] `defaults.js` 增加类型默认值与账号规范化
- [ ] `registry.js` 注册工厂
- [ ] `catalog.js` 增加展示信息（ready / planned）
- [ ] `listModels()` 返回统一字段，密钥不出现在 `describe()`
- [ ] `prepareRequest()` 至少处理 `model`、`stream` 与工具字段
- [ ] `chat()` 的 `release()` 幂等，异常路径也释放槽位
- [ ] `validate()` 在无凭据 / 无模型时返回明确错误
- [ ] 账号操作不会删除 `primary`（或按渠道语义明确允许）
- [ ] `npm run check` 与 `npm test` 通过
- [ ] README / `config.example.json` 补充示例（可选）

---

## 8. 测试

```bash
npm run check    # 所有源码语法检查
npm test         # 7 个测试套件
npm run test:ui  # 可选：无头 Chrome/Edge 加载控制台并操作连接向导
```

冒烟测试覆盖：健康检查、控制台状态、模型列表、启动、OpenAI 流式/非流式、
Anthropic 转换、第二渠道命名空间、鉴权失败、需 Key 预设的提前拒绝。

其余套件：连接层（Key 校验的 401/402/429 分支、本机探测）、剪贴板 Key 识别、
十个 OAuth provider 的完整流程、二维码独立解码往返、账号渠道运行时。

新增渠道时建议在 `scripts/` 下增加一个独立 fixture 测试，至少覆盖：

1. 登录 / 凭据写入（可用 mock HTTP）；
2. 模型列表；
3. 一次流式对话；
4. 一次 429 或 5xx 重试；
5. 账号切换与会话粘滞。
