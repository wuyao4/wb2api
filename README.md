# Buddy2API（workbuddy2api）

把 **WorkBuddy / CodeBuddy** 以及任意 **OpenAI 兼容网关** 统一变成你自己的
**OpenAI / Anthropic 兼容 API**。自带暗色玻璃拟态控制台：登录账号、添加渠道、选择默认模型、一键启动反代、生成 API Key。

- Node.js 实现，**零第三方依赖**（Node >= 18，使用内置 `fetch`）
- **多模块渠道架构**：新增一个渠道 = 新建一个 `src/channels/<name>/` 模块 + 注册一行
- 旧版单渠道 `config.json` **自动迁移**，接口与控制台保持兼容
- 真正的 SSE 流式透传、非流式本地聚合、Anthropic `/v1/messages` 转换
- 单渠道多账号：会话粘滞、429 冷却、账号级并发、一键故障转移

> 本项目只做协议转换。模型能力、额度与计费仍由各渠道账号决定，请遵守对应服务条款。

---

## 快速开始

```bash
cd wb2api
npm start
```

打开 **http://127.0.0.1:8787/**：

1. **连接 WorkBuddy**：点击「使用 WorkBuddy 账号登录」，浏览器完成授权后自动写入 token；
   也可以展开「手动填写 Token」粘贴 access token / refresh token / 请求头文本。
2. **（可选）添加更多渠道**：在「渠道」卡片点击「添加渠道」，选择预设（Kilo、OpenRouter、Groq、
   DeepSeek、Gemini、Ollama…）或填自定义 Base URL。
3. **生成反代与密钥**：选择默认模型，API Key 留空会自动生成。
4. **启动反代**，复制页面显示的 Base URL 与 Key。

客户端配置：

- Base URL：`http://127.0.0.1:8787/v1`
- API Key：控制台显示的那一串
- 模型：单渠道时可直接用 `deepseek-v4.1-flash`；多渠道时使用 `workbuddy/deepseek-v4.1-flash`

未启动时 `/v1/*` 返回 `503`，避免误用未配置的网关。

---

## 渠道体系

### 已实现（`status: ready`）

| 类型 | 说明 | 认证 |
| --- | --- | --- |
| `workbuddy` | 腾讯 WorkBuddy / CodeBuddy 账号渠道，支持多账号、会话粘滞、429 冷却、浏览器登录 | 浏览器授权 / Token |
| `openai-compatible` | 任何提供 `POST /chat/completions` 与 `GET /models` 的上游 | API Key / 免密 |

### 预设是否需要“登录”？

这些预设**都不是账号登录型渠道**（不需要 OAuth 扫码、不需要装客户端），
区别只在于**要不要自己申请一个 API Key**，以及**能否一键授权**。
下表是对真实端点实测的结果：

| 预设 | 需要登录/账号 | 需要 API Key | 连接方式 | 实测说明 |
| --- | --- | --- | --- | --- |
| **OpenRouter** | 需要（浏览器登录） | 是 | **一键授权** | 官方 OAuth PKCE + localhost 回调，登录后 Key 自动写回 |
| **WorkBuddy** | 需要（浏览器登录） | 否 | **一键授权** | 桌面端授权页轮询，登录后 token 自动写入 |
| **CodeBuddy（腾讯）** | 需要（浏览器登录） | 否 | **一键授权** | 与 WorkBuddy 同协议，`platform=codebuddy` |
| **Cline** | 需要（浏览器登录） | 否 | **一键授权** | 官方 WorkOS 设备码，显示设备码后自动完成，无需端口 |
| **Qoder** | 需要（浏览器登录） | 否 | **一键授权** | 官方 PKCE 设备码，打开授权页后自动轮询 |
| **Gemini Code Assist** | 需要（Google 登录） | 否 | **一键授权** | Google 官方 OAuth + PKCE，回调到本机端口 |
| **TRAE** | 需要（浏览器登录） | 否 | **一键授权** | 官方 PKCE，回调 `127.0.0.1:18080` |
| **Raccoon（商汤）** | 需要（微信扫码） | 否 | **一键扫码** | 二维码本机生成，扫码后自动轮询取回 token |
| **ZCode（智谱）** | 需要（浏览器登录） | 否 | **一键授权** | 服务端中介设备流，无需本地端口 |
| **MiniMax Code** | 需要（浏览器登录） | 否 | **一键授权** | 官方设备码 + PKCE |
| **Loomy（讯飞）** | 需要（手机号） | 否 | **短信登录** | 填手机号收验证码，HMAC-SHA1 签名 |
| **LobsterAI（有道）** | 需要（浏览器登录） | 否 | **一键授权** | 官方门户 + 本机回调 |
| Kilo.ai 免费池 | 否 | **否** | 免密 | 模型列表与对话均免密，已验证可用 |
| Ollama / LM Studio / llama.cpp | 否 | **否** | 免密 | 本机运行时，自动探测是否已启动 |
| Groq | 否 | 是 | 打开官方页 → 自动捕获 | 免费额度，注册即得 |
| DeepSeek | 否 | 是 | 打开官方页 → 自动捕获 | 需要余额 |
| Gemini（OpenAI 兼容） | 否 | 是 | 打开官方页 → 自动捕获 | AI Studio 创建 Key，有免费额度 |
| SiliconFlow | 否 | 是 | 打开官方页 → 自动捕获 | 部分小模型免费 |
| NVIDIA NIM | 否 | 是 | 打开官方页 → 自动捕获 | 模型列表公开可读，对话仍要 Key |
| Cerebras | 否 | 是 | 打开官方页 → 自动捕获 | 有免费额度 |
| Mistral | 否 | 是 | 打开官方页 → 自动捕获 | 有免费实验额度 |
| Together AI | 否 | 是 | 打开官方页 → 自动捕获 | 部分模型免费 |
| Fireworks | 否 | 是 | 打开官方页 → 自动捕获 | 注册送额度 |
| xAI (Grok) | 否 | 是 | 打开官方页 → 自动捕获 | 需付费额度 |
| Kimi / Moonshot | 否 | 是 | 打开官方页 → 自动捕获 | 部分模型有免费额度 |
| Z.ai | 否 | 是 | 打开官方页 → 自动捕获 | 注册即得 |
| MiniMax | 否 | 是 | 打开官方页 → 自动捕获 | 注册即得 |
| OpenCode Zen | 否 | 是 | 打开官方页 → 自动捕获 | 免费层拒绝第三方客户端，需 Console Key |
| Vercel AI Gateway | 否 | 是 | 打开官方页 → 自动捕获 | 模型列表公开可读，对话仍要 Key |

要点：

- **12 个渠道能真正一键**：它们各自开放了面向第三方应用的授权协议
  （OpenRouter PKCE、WorkBuddy/CodeBuddy 桌面授权、Cline WorkOS 设备码、
  Qoder PKCE 设备码、Google OAuth、TRAE PKCE、Raccoon 扫码、ZCode 服务端中介、
  MiniMax 设备码、Loomy 短信、LobsterAI 回调）。
  登录全程在浏览器（或手机）完成，凭据自动写回，无需复制。
- **其余 15 家用半自动**：这些服务商没有面向应用的 Key 创建 API。
  我用无头浏览器实测了 15 个 Key 页面，**全部落到登录墙**，没有一个能在未登录时
  到达"创建 Key"。要自动点按钮就必须先替用户登录、持有其账号会话，
  这是安全与条款取舍而非技术障碍。
- **复制之后全自动**：点完「打开官方 Key 页面」，控制台监听剪贴板，
  你复制 Key 的一瞬间它就被自动填入、校验、写盘，并给出「立即启动网关」。
- **`GET /models` 返回 200 不代表能对话**。NVIDIA、Vercel、OpenRouter 的模型目录
  都是公开的，但对话接口返回 401。所以校验一律用 `max_tokens: 1` 的真实请求。
- **OpenCode Zen 不是免密渠道**：它的免费层返回
  `FreeTierError: can only be used from within OpenCode`，校验客户端形态，
  必须用 Console 的 Key。

完整分析与实测数据见 [`docs/CONNECT.md`](docs/CONNECT.md)。

`openai-compatible` 内置预设（来自参考项目的提供商注册表）：

`Kilo.ai 免费池`、`OpenRouter`、`Groq`、`DeepSeek`、`Gemini`、`SiliconFlow`、`NVIDIA NIM`、
`Cerebras`、`Mistral`、`Together`、`Fireworks`、`xAI`、`Kimi / Moonshot`、`Z.ai`、`MiniMax`、
`OpenCode Zen`、`Vercel AI Gateway`、`Ollama`、`LM Studio`、`llama.cpp`。

预设只负责填表；除本机运行时和 Kilo 免费池外，通常仍需要自己的 Key。

### 规划中（参考 dsh-our-free-model 的账号渠道）

这些渠道需要各自的 OAuth / 设备签名 / 验证码流程，尚未在本仓库实现，
但目录与注册表已经为它们留好位置。实现时按 `docs/CHANNELS.md` 新增独立模块即可：

`Qoder`、`TRAE`、`Cline`、`Loomy`、`Raccoon`、`ZCode`、`MiniMax Code`、
`Gemini Code Assist`、`CodeArts`、`LobsterAI`、`EAC（桌面端）`。

规划状态会在控制台「添加渠道」类型列表里显示，但选择后会明确提示「尚未实现」。

---

## 模型命名与路由

| 场景 | `/v1/models` 暴露的 id | 说明 |
| --- | --- | --- |
| 只启用一个渠道 | `deepseek-v4.1-flash` | 与旧版完全一致 |
| 启用多个渠道 | `workbuddy/deepseek-v4.1-flash`、`kilo/kimi-k2` | 用 `渠道ID/上游模型ID` 消歧 |

请求侧始终接受三种写法：

1. `channel/model` —— 直接路由到指定渠道；
2. 渠道别名（如 WorkBuddy 的 `gpt-4o` → `deepseek-v4.1-flash`）；
3. 裸模型 id —— 在所有启用渠道中查找；找不到时交给默认渠道（保持旧行为）。

可通过 `routing` 调整：

```jsonc
"routing": {
  "defaultModel": "workbuddy/deepseek-v4.1-flash",
  "aliases": { "fast": "kilo/kimi-k2" }, // 全局别名
  "namespace": "auto",                   // auto | always | never
  "exposeUnprefixed": false              // 多渠道时是否额外暴露唯一裸 id
}
```

---

## 配置（`config.json`，v2）

首次启动可复制 `config.example.json`。旧版结构（顶层 `upstream` / `accounts` / `models`）
会在读取时自动迁移，并在下一次保存时写回 v2。

```jsonc
{
  "version": 2,
  "server": {
    "host": "127.0.0.1",
    "port": 8787,
    "apiKeys": ["sk-wb2api-local"],
    "adminToken": "",
    "running": false,
    "requestBodyLimitMb": 128
  },
  "routing": {
    "defaultModel": "workbuddy/deepseek-v4.1-flash",
    "aliases": {},
    "namespace": "auto"
  },
  "channels": {
    "workbuddy": {
      "type": "workbuddy",
      "enabled": true,
      "label": "WorkBuddy",
      "options": {
        "baseUrl": "https://www.workbuddy.ai",
        "domain": "www.workbuddy.ai",
        "product": "SaaS",
        "client": { "userAgent": "WorkBuddy/5.8.4 ...", "ideVersion": "5.8.4" },
        "refreshSkewSeconds": 600,
        "headerTimeoutMs": 120000
      },
      "models": {
        "default": "deepseek-v4.1-flash",
        "aliases": { "gpt-4o": "deepseek-v4.1-flash" },
        "fallback": {},
        "allowUnknown": true,
        "cacheTtlSeconds": 600,
        "contextWindow": { "default": 1000000, "overrides": {} }
      },
      "routing": {
        "sessionAffinity": true,
        "affinityTtlMinutes": 60,
        "affinityOnCooldown": "prefer",
        "failover": true,
        "defaultAccountConcurrency": 2
      },
      "accounts": [
        {
          "id": "primary",
          "label": "主账号",
          "enabled": true,
          "maxConcurrency": 1,
          "accessToken": "",
          "refreshToken": "",
          "deviceToken": "",
          "userId": ""
        }
      ]
    },

    // 一个 OpenAI 兼容渠道的示例（Kilo 免费池）
    "kilo": {
      "type": "openai-compatible",
      "enabled": true,
      "label": "Kilo 免费池",
      "options": {
        "baseUrl": "https://api.kilo.ai/api/gateway",
        "apiKey": "",
        "modelsPath": "/models",
        "chatPath": "/chat/completions",
        "includeUsage": true,
        "models": []
      },
      "models": {
        "aliases": {},
        "allowUnknown": true,
        "contextWindow": { "default": 0, "overrides": {} }
      }
    }
  },
  "prompt": { "system": "You are a helpful assistant.", "injectWhenMissing": true },
  "retry": { "maxAttempts": 3, "baseDelayMs": 2500, "maxDelayMs": 20000 },
  "logging": { "requests": true }
}
```

环境变量覆盖：`WB2API_CONFIG`、`WB2API_HOST`、`PORT`、`WB2API_API_KEYS`、`WB2API_DEFAULT_MODEL`、
`WB2API_SYSTEM_PROMPT`；旧版的 `WB2API_BASE_URL` / `WB2API_ACCESS_TOKEN` / `WB2API_REFRESH_TOKEN` /
`WB2API_DEVICE_TOKEN` / `WB2API_USER_ID` 仍然作用于 `workbuddy` 渠道主账号。

---

## 添加渠道

### 连接向导（推荐）

控制台的「连接向导」把每个服务商按连接方式分三档，点一下就知道该做什么：

| 标记 | 含义 | 你只需要 |
| --- | --- | --- |
| **官方 OAuth · 一键** | 上游提供面向应用的授权协议（12 个渠道） | 点「一键授权」，在浏览器登录确认 |
| **需 API Key** | 上游只提供网页后台（15 个渠道） | 点「打开官方 Key 页面」→ 登录 → 创建 Key → 复制（会自动捕获） |
| **免密** | 不需要账号（Kilo 免费池 / 本机运行时） | 点「直接添加」 |

无论哪一档，完成后都会显示「已加入代理池」，并给出「查看代理池 / 更新并应用」按钮；凭据、账号和模型路由一次完成。

**一键流程一览**：

| 渠道 | 你会看到 | 背后发生的事 |
| --- | --- | --- |
| OpenRouter | 浏览器授权页 | OAuth PKCE，回调本机端口换出 API Key |
| Cline | 设备码 + 授权链接 | WorkOS device-code 轮询，无需端口 |
| Qoder | 浏览器授权页 | PKCE 设备码轮询 |
| Gemini Code Assist | Google 登录页 | Google OAuth + PKCE，回调本机端口 |
| TRAE | 浏览器授权页 | PKCE，回调 `127.0.0.1:18080` |
| Raccoon（商汤） | 微信二维码 | 本机生成二维码，扫码后轮询取回 token |
| ZCode（智谱） | 浏览器授权页 | 服务端中介设备流，无需端口 |
| MiniMax Code | 设备码 + 授权链接 | 设备码 + PKCE 轮询 |
| Loomy（讯飞） | 手机号 + 验证码 | HMAC-SHA1 签名的短信登录 |
| LobsterAI（有道） | 浏览器授权页 | 官方门户 + 本机回调 |
| WorkBuddy / CodeBuddy | 浏览器授权页 | 桌面端授权页轮询，token 自动写入 |

> WorkBuddy 的账号统一在控制台「代理池」里添加：点「添加账号」直接走浏览器授权，支持多账号、并发与会话粘滞。

二维码由本机生成（自带编码器，零依赖），不经过任何第三方图床，
扫码用的 code 只留在本机。

**「需 API Key」这一档实际要做的事**：点开官方页面 → 登录 → 点「Create API Key」→
点复制。复制之后**不需要粘贴**：控制台在后台监听剪贴板，识别到 Key 就自动填入、
校验、写盘。读不到剪贴板时会退回手动粘贴。

**一键授权是怎么工作的**（以 OpenRouter 为例）：

1. 本机在 `127.0.0.1` 的随机端口起回调监听；
2. 打开官方授权页，带 PKCE challenge、`state` 和 `key_label=Buddy2API`；
3. 你登录并授权后，浏览器跳回本地回调；
4. 服务端校验 `state`，用 `code_verifier` 换取凭据；
5. 凭据写入 `config.json`（0600），随即校验可用性；
6. 校验通过 → 账号自动加入代理池，按需「更新并应用」网关。

`state` 一次性、10 分钟过期，未知 state 一律拒绝；凭据只交付一次。

**为什么其余渠道不能一键**：它们没有面向第三方应用的 Key 创建 API
（我核查过 OIDC 发现文档，DeepSeek / Moonshot / 智谱 / MiniMax / SiliconFlow / Cerebras 全部缺失）。
我用无头浏览器实测了 15 个 Key 页面：**全部落到登录墙**，没有一个能在未登录状态下到达"创建 Key"。
要自动点按钮就必须先替用户登录、持有其账号会话，这不是技术障碍而是安全与条款取舍，
因此选择"打开官方页 + 剪贴板自动捕获 + 自动校验"。

> 参考项目 `dsh-our-free-model` 的账号渠道（Cline / Gemini / TRAE / Qoder / Raccoon）
> 用的也是各自官方开放的 OAuth / device-code 流程，不是自动化网页。
> 这些渠道已按同样思路移植完成。

完整分析与实测数据见 [`docs/CONNECT.md`](docs/CONNECT.md)。

### 手动添加

「渠道」→「自定义渠道」，适合自建网关或未列出的服务商：

- 渠道 ID（也会成为模型前缀，例如 `kilo/kimi-k2`）
- 显示名称
- Base URL
- API Key（免密渠道可留空）
- 静态模型清单（当上游没有 `/models` 时使用）

添加后会自动出现在模型选择器里；重新选择默认模型并「更新并应用」即可。

---

## 模型测试

控制台「测试」页可以直接对指定模型发一轮对话：

1. 进入「测试」，点「刷新模型列表」；
2. **先选渠道**，再在可搜索下拉框里选择该渠道的模型；选择「全部渠道」时，下拉框也会按渠道分组；
3. 填写输入内容（可选系统提示词、最大输出 Tokens、Temperature）；
4. 点「发送测试」，右侧会显示上游输出、渠道、账号、首字延迟、耗时和 Tokens。

测试直接调用渠道账号，**不需要先启动网关**；每次测试都会写入请求日志，并消耗对应账号的额度。

---

也可以用 `POST /admin/channels/create`：

```bash
curl http://127.0.0.1:8787/admin/channels/create ^
  -H "Content-Type: application/json" ^
  -d "{\"id\":\"kilo\",\"type\":\"openai-compatible\",\"label\":\"Kilo\",\"baseUrl\":\"https://api.kilo.ai/api/gateway\",\"models\":\"\"}"
```

### 新增渠道类型（代码）

1. 在 `src/channels/<name>/` 新建 `index.js`（实现渠道运行时）与 `client.js`（上游传输）。
2. 在 `src/channels/defaults.js` 增加该类型的默认配置与账号结构。
3. 在 `src/channels/registry.js` 的 `DEFINITIONS` 注册工厂函数。
4. 在 `src/channels/catalog.js` 增加控制台展示信息。
5. 运行 `npm test`（内置 mock 上游的端到端冒烟测试）。

渠道运行时只需要实现：

```js
{
  id, type, label, enabled, capabilities,
  listModels({ force }),          // -> 规范化模型数组
  resolveModel(id),               // 客户端模型 id -> 上游模型 id
  hasModel(id),                   // 用于裸 id 消歧（同步）
  prepareRequest(body, model),    // 组装上游请求体
  chat({ body, options, sessionKey }), // -> { res, release, model, account }
  status(), describe(), validate(),
  // 可选：loginStart / loginStatus / applyCredentials / refreshAccount
  // 可选：updateAccount / toggleAccount / removeAccount
}
```

详细契约、代码骨架与参考项目模块对照见 [`docs/CHANNELS.md`](docs/CHANNELS.md)。

---

## 多账号与会话保持（WorkBuddy 渠道）

- 主账号在 `channels.workbuddy.accounts[0]`（`id: "primary"`），额外账号追加在同一数组。
- 每个账号独立 token、刷新、冷却、并发；总并发约等于各账号 `maxConcurrency` 之和。
- 新请求优先选择负载最低且未冷却的账号。
- 同一会话优先使用同一账号：读取 `X-Session-ID` / `X-Conversation-ID` / body 的
  `session_id` / `conversation_id` / `user`；没有时用第一条 user 消息的 SHA-256。
- 429 时尝试另一个账号一次（`routing.failover`）。
- `routing.affinityOnCooldown: "prefer"`（默认）在冷却时换号，`"wait"` 则保持会话等待冷却。

控制台「代理池」按渠道分组显示**所有渠道**的账号与 Key 凭据，顶部汇总账号数、可用并发和会话数；新授权或新增的账号会自动出现在对应渠道分组里。WorkBuddy / CodeBuddy 支持追加多个账号，每个账号独立并发与冷却。

---

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 控制台 |
| POST | `/v1/chat/completions` | OpenAI 兼容，流式 / 非流式、tools、图片 |
| POST | `/v1/messages` | Anthropic 兼容，流式 / 非流式、tools |
| GET | `/v1/models` | 聚合所有启用渠道的模型 |
| GET | `/healthz` | 健康检查（含渠道列表） |
| GET | `/admin/status` | 控制台状态、默认渠道、全部渠道与统计 |
| POST | `/admin/test-chat` | 对指定模型执行一次测试对话（不需要先启动网关） |
| GET | `/admin/channels` | 渠道详情、可选类型与预设 |
| POST | `/admin/channels/create` | 新建渠道 |
| POST | `/admin/channels/update` | 修改渠道（label / enabled / baseUrl / key / 模型清单） |
| POST | `/admin/channels/test` | 校验渠道凭据并刷新模型 |
| POST | `/admin/channels/toggle` | 启用 / 停用渠道 |
| POST | `/admin/channels/remove` | 删除渠道 |
| GET | `/admin/connect/presets` | 预设及其连接策略（oauth / open-key / keyless） |
| GET | `/admin/connect/local?preset=ollama` | 探测本机运行时是否已启动 |
| GET | `/admin/connect/clipboard` | 读取剪贴板中的 Key 候选（只返回形状检查通过的） |
| POST | `/admin/connect/verify` | 用真实对话校验 API Key（不落盘） |
| POST | `/admin/connect/oauth/start` | 发起一键授权（返回 mode / authUrl / userCode / qrSvg） |
| GET | `/admin/connect/oauth/status?provider=&state=` | 轮询授权结果并自动写入凭据 |
| POST | `/admin/connect/oauth/refresh` | 用 refresh_token 续期 |
| POST | `/admin/routing/update` | 更新全局默认模型 / 别名 / 命名空间 |
| POST | `/admin/credentials` | 校验并保存凭据（`channel` 可选） |
| POST | `/admin/login/start` | 发起浏览器登录（`channel` 可选） |
| GET | `/admin/login/status?state=...` | 轮询登录结果 |
| POST | `/admin/accounts/toggle` | 启用 / 停用账号（`channel` 可选） |
| POST | `/admin/accounts/update` | 修改账号标签 / 并发 |
| POST | `/admin/accounts/remove` | 删除额外账号 |
| POST | `/admin/start` | 校验所有启用渠道并启动反代 |
| POST | `/admin/stop` | 停止反代 |
| POST | `/admin/key` | 重新生成 API Key |
| GET | `/admin/models` | 聚合模型列表 |
| GET | `/admin/logs` | 最近 60 条请求日志 |
| POST | `/admin/refresh` | 刷新 access token（`channel` / `accountId`） |
| POST | `/admin/reload` | 重新读取 `config.json`（监听端口变更需重启） |

`/admin/*` 默认只允许本机访问；配置 `server.adminToken` 后需要携带 `X-Admin-Token`。

---

## 目录结构

```
src/
  index.js                 入口：加载运行时就绪后启动 HTTP
  runtime.js               组装根：可变配置 + 渠道注册表 + 持久化
  server.js                HTTP 路由、静态资源、鉴权
  admin/routes.js          控制台 API（状态、渠道、账号、登录、启动/停止）
  core/
    config.js              v2 配置、旧版迁移、环境变量
    http.js                JSON/CORS/静态文件/鉴权工具
    pool.js                通用账号池：粘滞会话、冷却、故障转移
    clipboard.js           本机剪贴板读取与 Key 候选识别
    qr.js                  零依赖二维码编码器（SVG，本机渲染）
    sse.js                SSE 解析与背压写入
    store.js              内存统计与请求日志
    credentials.js        JWT / Token / API Key 工具
    errors.js, ids.js, logger.js, util.js
  channels/
    defaults.js           各渠道类型的默认配置与规范化
    registry.js           渠道工厂注册 + 模型命名空间解析
    catalog.js            控制台渠道目录与 OpenAI 兼容预设
    connect.js            连接策略：Key 校验、本机探测、策略元数据
    oauth/
      base.js             会话管理、本机回调监听、轮询退避
      index.js            官方授权渠道注册表（10 个 provider）
      openrouter.js       OpenRouter OAuth PKCE
      cline.js            Cline WorkOS 设备码
      qoder.js            Qoder PKCE 设备码
      gemini.js           Gemini Code Assist（Google OAuth）
      trae.js             TRAE PKCE + 本机回调
      raccoon.js          Raccoon 微信扫码 + 轮询
      zcode.js            ZCode 服务端中介设备流
      minimax.js          MiniMax Code 设备码 + PKCE
      loomy.js            Loomy 短信登录（HMAC-SHA1 签名）
      lobsterai.js        LobsterAI 授权码 + 本机回调
    account/
      index.js            账号渠道运行时（共享传输 + 每渠道 spec）
    workbuddy/
      index.js            渠道运行时（账号池、模型、登录、凭据）
      client.js           上游客户端（鉴权头、刷新、重试、冷却）
      config.js           账号配置 -> 客户端配置
      models.js           静态模型表与模型字段规范化
    openai-compatible/
      index.js            通用渠道运行时
      client.js           通用 OpenAI 兼容传输与模型发现
  protocol/
    openai.js             OpenAI 请求整理、SSE 透传、非流式聚合
    anthropic.js          Anthropic /v1/messages 转换
  serving/chat.js          两个协议端点的统一处理管线
  serving/start.js         渠道校验 + 反代启动（控制台与向导共用）
public/                    控制台（无框架）
scripts/smoke-test.mjs     mock 上游端到端测试
scripts/connect-test.mjs   连接层测试（Key 校验、本机探测）
scripts/oauth-test.mjs     十个账号渠道的授权流程测试
scripts/qr-test.mjs        二维码编码器往返校验（独立解码器）
scripts/account-test.mjs   账号渠道运行时测试
scripts/clipboard-test.mjs 剪贴板 Key 识别测试
scripts/e2e-oauth-test.mjs 授权 → 落盘 → 启动 → 对话的完整链路
scripts/boot-test.mjs      真实入口冷启动与优雅退出
scripts/ui-smoke-test.mjs  无头浏览器控制台测试（26 项）
scripts/screenshots.mjs    可选：每个视图的截图
scripts/live-connect.mjs   可选：探测真实 Key 页面与免密渠道
scripts/live-auth.mjs      可选：探测十个账号渠道的真实授权端点
docs/CHANNELS.md           渠道扩展指南
docs/CONNECT.md            连接方式分析（谁能一键、为什么）
```

---

## WorkBuddy 上游要点

从桌面端抓包确认的协议（实现位于 `src/channels/workbuddy/client.js`）：

| 项目 | 值 |
| --- | --- |
| 对话接口 | `POST https://www.workbuddy.ai/v2/chat/completions` |
| Token 刷新 | `POST https://www.workbuddy.ai/v2/plugin/auth/token/refresh` |
| 模型列表 | `GET https://www.workbuddy.ai/v3/config` |
| 鉴权 | `Authorization: Bearer <accessToken>` |
| 刷新凭据 | `X-Refresh-Token: <refreshToken>` |

代理已处理的限制：

1. 上游只支持流式；代理始终用 `stream: true`，客户端要非流式时本地聚合。
2. 第一条消息必须是 `system`；代理自动补齐（`prompt.system`）。
3. 必须带一组配套的 `X-Conversation-*` / `X-Request-*` id；代理为每个请求生成 ULID/UUID。
4. 需要 WorkBuddy/CodeBuddy 客户端版本头；按抓包原样发送。
5. 免费模型限流很紧；默认串行、指数退避、429 共享冷却。

上下文窗口：默认向客户端声明 1M，并按模型 `maxInputTokens` 收敛；代理**不截断消息**。
控制台可按模型保存 override。

---

## 开发与测试

```bash
npm run check        # 全量语法检查
npm test             # 7 个测试套件（冒烟 / 连接 / 剪贴板 / OAuth / 二维码 / 账号渠道 / 端到端）
npm run test:ui      # 可选：无头 Chrome/Edge 加载控制台并操作连接向导
npm run test:live    # 可选：WB2API_LIVE=1 探测真实 Key 页面与免密渠道
node scripts/live-auth.mjs   # 可选：探测十个账号渠道的真实授权端点（不完成登录）
```

`test:ui` 在找不到 Chromium 或 Node < 22 时自动跳过。

真实上游探测（会消耗极少量额度）：

```bash
WB2API_LIVE=1 WB2API_LIVE_GROQ_KEY=gsk_xxx node scripts/live-connect.mjs
```

---

## 迁移说明

- 旧版 `config.json`（有顶层 `upstream`）在启动时自动迁移为 `channels.workbuddy`，
  旧的多账号数组继续保留，`models` 与账号路由设置原样搬入该渠道。
- 迁移结果在下一次保存时落盘；旧字段随后不再写入。
- 迁移后如仍希望单渠道裸模型 id，保持默认 `routing.namespace: "auto"` 即可；
  只有启用第二个渠道时才会切换为 `channel/model`。
- `bin/setup.js`、`bin/refresh.js`、`tools/wb-login.mjs` 已适配 v2 配置。

---

## 注意事项

- `config.json` 里的 token / API Key 等同于账号凭据，请勿提交或分享；文件以 `0600` 写入。
- 默认只监听 `127.0.0.1`。局域网访问请改 `server.host` 并设置 `server.apiKeys` 与 `server.adminToken`。
- 统计和日志只保存在内存中，重启进程后清空。
- 上游返回的 `reasoning_content`（思维链）在流式响应中原样保留，非流式放在
  `message.reasoning_content`；Anthropic 接口会转为 `thinking` 块。
- Kilo 免费池由上游免费提供，其模型卡声明提示可能被记录用于改进服务；请勿发送敏感内容。
