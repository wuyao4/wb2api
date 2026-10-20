# workbuddy2api

把 WorkBuddy（`www.workbuddy.ai`）的模型反代成 **OpenAI 兼容** / **Anthropic 兼容** API。自带一个暗色玻璃拟态控制台：粘贴 token → 选择模型 → 一键启动 → 自动生成专属反代地址和 API Key。

纯 Node.js 实现，零第三方依赖（Node >= 18，使用内置 `fetch`）。

## 控制台

```bash
cd wb2api
npm start
```

打开 **http://127.0.0.1:8787/**，三步即可用：

1. **连接 WorkBuddy**：点击「使用 WorkBuddy 账号登录」，浏览器会打开 WorkBuddy 授权页；完成登录后控制台自动拿到桌面端 token 并显示账号，无需复制。也可以展开「手动填写 Token（可选）」粘贴 access token / refresh token、请求头文本或 JSON 作为备用方式。
2. **生成反代与密钥**：选择默认模型，API Key 可留空（启动时自动生成）或自己填写 / 点「生成」。
3. **启动反代**：点击「启动反代」，页面会显示 Base URL 与 API Key，可一键复制、重新生成 Key、停止服务。

启动后把客户端指向：

- Base URL：`http://127.0.0.1:8787/v1`
- API Key：控制台里显示的那一串
- 模型：`deepseek-v4.1-flash`，或 `GET /v1/models` 返回的任意模型

> 未启动时 `/v1/*` 会返回 `503`，避免误用未配置的网关。

控制台功能：

- 一键 WorkBuddy 账号登录，自动捕获桌面端 token 并显示账号
- 手动填写 Token 作为可选备用方式，自动解析 JWT、识别访问令牌 / 刷新令牌
- 实时请求日志（模型、状态、耗时、token 用量）
- 请求数 / 输入输出 token / 运行时长统计
- Token 到期倒计时、一键刷新
- 生成 / 重置 API Key，停止 / 再次启动反代
- 移动端自适应

## HAR 分析结论

从抓包文件（Reqable 导出的 HAR）里确认的上游协议：

| 项目 | 值 |
| --- | --- |
| 对话接口 | `POST https://www.workbuddy.ai/v2/chat/completions` |
| Token 刷新 | `POST https://www.workbuddy.ai/v2/plugin/auth/token/refresh` |
| 模型列表 | `GET https://www.workbuddy.ai/v3/config` |
| 鉴权 | `Authorization: Bearer <accessToken>`（JWT，约 1 年有效） |
| 刷新凭据 | `X-Refresh-Token: <refreshToken>` |
| 可选设备头 | `X-Device-Token`、`X-User-Id`（实测聊天不需要，但支持配置） |
| 协议 | 请求/响应均为 OpenAI Chat Completions 格式（SSE 流式） |

关键限制（都已在代理中处理）：

1. **上游只支持流式**：`stream: false` 会返回 `11101 Non-stream chat request is currently not supported`，所以代理始终用 `stream: true` 请求上游，客户端要非流式时在本地聚合。
2. **第一条消息必须是 `system`**：否则返回 `11128 first message is not system prompt`。代理会自动补一条 system 消息（内容见 `prompt.system`）。
3. **必须带一组配套的 ID 请求头**：`X-Conversation-ID`、`X-Request-ID`、`X-Conversation-Message-ID`、`X-Conversation-Request-ID`、`X-Root-Request-ID`，缺一个都会 `11128 request illegal`。代理为每个请求生成新的 ULID/UUID。
4. **客户端版本头**：`X-Product: SaaS`、`X-IDE-*`、`x-codebuddy-request: 1`、`User-Agent: WorkBuddy/...` 等，按抓包原样发送。
5. **限流很紧**：`deepseek-v4.1-flash` 等模型连续调用会返回 `14003 too many requests / Model busy`。代理默认串行请求，并按指数退避重试。
6. 模型列表来自 `/v3/config`（27 个模型，含 DeepSeek / GPT / Claude 系 / Gemini / GLM / Kimi 等）。

## 上下文窗口（300K → 1M）

抓包里可以看到 WorkBuddy 桌面端的 Context 选项：

```json
{"method":"session/set_config_option",
 "params":{"configId":"context_window","value":"300000"}}
```

它属于 **ACP 会话参数**（默认 300K，可选 1M），并不会出现在 `/v2/chat/completions` 的请求体里。HTTP 模型接口的实际上限是模型的 `maxInputTokens`：`deepseek-v4.1-flash` 为 **1,000,000**。

因此代理侧的做法是：

- 默认向客户端声明 **1M**：`models.contextWindow.default = 1000000`
- 按每个模型的 `maxInputTokens` 自动收敛（Auto 176K、DeepSeek 1M、Grok 500K…）
- **绝不截断消息**，客户端发多少上下文就转发多少
- 控制台新增「上下文窗口」选择器，按模型支持的档位（300K / 1M 等）保存 per-model override
- `/v1/models` 同时返回 `context_length`、`context_window`、`max_context_length`、`max_input_tokens`，兼容不同客户端

如果你用的客户端仍然显示 300K，改客户端里的模型上下文设置即可——代理和上游都支持 1M。

## 流式与性能

反代是真正的 SSE 流式透传，不是收完整段再返回：

- 上游每个 chunk 到达后立即写回客户端，`: heartbeat` 也会原样透传
- 请求真实模型 ID 时走**零解析快速路径**：字节直接 pipe，不做逐 token 的 JSON parse/stringify
- 只有使用模型别名或 fallback 时才逐行改写，把响应里的 model 改回客户端请求的名字
- **慢客户端背压**：`res.write()` 返回 false 时暂停读取上游，避免内存无限增长
- SSE 响应执行 `flushHeaders()`、`socket.setNoDelay(true)`，并带 `X-Accel-Buffering: no` / `no-transform`，避免 nginx 等中间层缓冲
- **429 共享冷却**：触发限流后设置冷却窗口，排队请求不会同时撞限流；token 刷新单飞，模型列表缓存 10 分钟
- 请求体只 `JSON.stringify` 一次，401 刷新或重试时复用
- 日志新增 `ttfbMs`（首包耗时），控制台请求行 hover 可查看，服务端日志也会打印 `ttfb=...`

实测（本地 mock 上游每 300ms 发一个 chunk）：

```
chunk 到达: 53ms, 347ms, 658ms, 969ms, 1281ms, 1591ms
```

682KB / 2002 个 SSE 事件的大响应也能完整透传并正确提取 usage。

可调性能项：

| 配置 | 说明 |
| --- | --- |
| `upstream.maxConcurrency` | 默认 1；免费号建议保持，付费/多账号可调大 |
| `retry.baseDelayMs` / `maxAttempts` | 429 重试节奏 |
| `models.fallback` | 限流时自动切换模型 |
| `models.cacheTtlSeconds` | 模型列表缓存时长 |

> 非流式请求会在代理本地聚合整段 SSE，延迟等于完整生成时间；追求低延迟请在客户端开启 `stream: true`。
>
> 修改 `src/server.js`、`src/openai.js`、`src/workbuddy.js` 后需要重启 `npm start`；只改 `public/` 前端刷新页面即可。

## 客户端示例

cURL：

```bash
curl http://127.0.0.1:8787/v1/chat/completions ^
  -H "Authorization: Bearer <控制台里的 API Key>" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"deepseek-v4.1-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}],\"stream\":true}"
```

Python（官方 openai SDK）：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="<控制台里的 API Key>")
resp = client.chat.completions.create(
    model="deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

Claude Code / Anthropic 协议：

- Base URL：`http://127.0.0.1:8787`
- 接口：`POST /v1/messages`，支持 `stream`、`tools`、`tool_use` / `tool_result` 转换。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 反代控制台 |
| POST | `/v1/chat/completions` | OpenAI 兼容，支持流式/非流式、tools、图片 |
| POST | `/v1/messages` | Anthropic 兼容，支持流式、tools |
| GET | `/v1/models` | 实时模型列表（含别名） |
| GET | `/healthz` | 健康检查 |
| GET | `/admin/status` | 控制台状态、账号、统计 |
| POST | `/admin/credentials` | 解析并保存 Token |
| POST | `/admin/login/start` | 创建桌面登录 state 与授权地址 |
| GET | `/admin/login/status?state=...` | 轮询授权结果并自动保存 token |
| POST | `/admin/start` | 启动 / 更新反代，生成 Key |
| POST | `/admin/stop` | 停止反代 |
| POST | `/admin/key` | 重新生成 API Key |
| GET | `/admin/models` | 模型列表（供控制台选择） |
| GET | `/admin/logs` | 最近 60 条请求日志 |
| POST | `/admin/refresh` | 立即刷新 access token |
| POST | `/admin/reload` | 重新读取 `config.json`（无需重启） |

`/admin/*` 默认只允许本机访问；配置了 `server.adminToken` 后，所有管理请求都需要携带 `X-Admin-Token`（控制台会弹窗询问并记住）。

## 配置说明（config.json）

```jsonc
{
  "server": {
    "host": "127.0.0.1",
    "port": 8787,
    "apiKeys": ["sk-wb2api-local"],   // 启动时会被生成的新 Key 替换
    "adminToken": "",                 // 非本机访问管理接口时必填
    "running": false,                 // 控制台点「启动反代」后为 true
    "requestBodyLimitMb": 128
  },
  "upstream": {
    "baseUrl": "https://www.workbuddy.ai",
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",         // 推荐填写，可自动续期
    "deviceToken": "v3:...",          // 可选
    "userId": "b3d9...",              // 可选
    "maxConcurrency": 1,              // 上游并发，免费号建议 1
    "refreshSkewSeconds": 600         // 提前多久刷新
  },
  "models": {
    "default": "deepseek-v4.1-flash",
    "contextWindow": {                 // 向客户端声明的上下文窗口
      "default": 1000000,              // 默认 1M，按模型 maxInputTokens 自动收敛
      "overrides": {}                  // 例如 { "default-model": 176000 }
    },
    "aliases": { "gpt-4o": "deepseek-v4.1-flash" },
    "fallback": {                     // 429 重试耗尽后换模型；会消耗 credits
      "deepseek-v4.1-flash": ["deepseek-v4.1-flash-sg"]
    }
  },
  "prompt": {
    "system": "You are a helpful assistant.",
    "injectWhenMissing": true
  },
  "retry": { "maxAttempts": 3, "baseDelayMs": 2500, "maxDelayMs": 20000 }
}
```

环境变量覆盖（适合 Docker / 不落盘）：

`WB2API_CONFIG`、`WB2API_HOST`、`PORT`、`WB2API_API_KEYS`（逗号分隔）、`WB2API_BASE_URL`、`WB2API_ACCESS_TOKEN`、`WB2API_REFRESH_TOKEN`、`WB2API_DEVICE_TOKEN`、`WB2API_USER_ID`、`WB2API_DEFAULT_MODEL`、`WB2API_SYSTEM_PROMPT`。

### 更新凭据

在控制台重新粘贴 token 即可。也可以命令行：

```bash
npm run setup
# 依次粘贴 refreshToken / accessToken / deviceToken / userId
# 或：node bin/setup.js --refresh-token "eyJ..." --device-token "v3:..." --user-id "..."
```

只刷新 token：

```bash
npm run refresh
```

刷新成功后新的 access / refresh token 会自动写回 `config.json`。

### 一键重新登录（桌面版同款 state 流程）

运行：

```bash
npm run login
```

或直接双击项目根目录的 `wb-login.cmd`。流程和桌面版完全一致：

1. 读取 `config.json` 里的 `upstream.deviceToken`
2. `POST /v2/plugin/auth/state?platform=workbuddy-ai&version=5.8.4` 创建 `state` + `authUrl`
3. 打开浏览器登录；网页端会把账号绑定到这个 `state`
4. 轮询 `GET /v2/plugin/auth/token?state=...`，拿到桌面端 access/refresh token
5. 自动调用 `/admin/credentials` 写入配置；服务未启动时直接写 `config.json`

建议运行前先退出桌面版 WorkBuddy，避免桌面端抢先消费这个 `state`。需要 `config.json` 里有 `upstream.deviceToken`（抓包时已经保存）。

## 限流与模型选择

- `deepseek-v4.1-flash` 是活动免费模型，高频调用会 `14003 Model busy`；代理默认串行 + 指数退避重试。
- 付费/有额度的模型（如 `deepseek-v4.1-flash-sg`、`kimi-k3`）通常不受免费池限流影响，会消耗账号 credits。
- 想让免费模型被限流时自动切付费模型，在 `models.fallback` 里配置映射即可（默认留空，避免意外扣费）。
- 控制台顶部状态：`未配置` → `已连接 · 未启动` → `运行中`。

## 目录结构

```
public/
  index.html        控制台页面
  style.css         暗色玻璃拟态样式
  app.js            控制台交互（无框架）
  favicon.svg
src/index.js        入口（检查凭据）
src/server.js       HTTP 服务、鉴权、控制台 API、静态资源
src/workbuddy.js    上游客户端：鉴权头、token 刷新、限流重试、模型列表
src/openai.js       OpenAI 请求整理、SSE 转发、非流式聚合
src/anthropic.js    Anthropic /v1/messages 协议转换
src/credentials.js  Token / 请求头 / JSON 解析
src/store.js        内存统计与请求日志
bin/setup.js        交互式写入凭据
bin/refresh.js      手动刷新 token
config.json         运行配置（含真实凭据，已被 .gitignore 忽略）
```

## 注意事项

- `config.json` 里的 token / device token 等同于账号凭据，请勿提交到仓库或分享；控制台保存后会把 token 从输入框清除。
- 该代理只是协议转换，模型能力、额度、计费仍由 WorkBuddy 账号决定；请遵守其服务条款。
- 默认只监听 `127.0.0.1`。如需局域网访问，把 `server.host` 改成 `0.0.0.0`，并设置强 `server.apiKeys` 与 `server.adminToken`。
- 统计和日志只保存在内存中，重启进程后清空。
- 上游返回的 `reasoning_content`（思维链）在流式响应中原样保留，非流式响应放在 `message.reasoning_content`；Anthropic 接口会转成 `thinking` 块。
