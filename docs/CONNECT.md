# 渠道连接方式分析

本文记录每个内置渠道**能否做到一键授权**、依据是什么，以及实测数据。
所有"可用/不可用"的结论都来自对真实端点的探测，不是推断。

---

## 一、结论

| 能力 | 数量 | 渠道 |
| --- | --- | --- |
| **真·一键**（点一下 → 浏览器授权 → 凭据自动写回） | **11** | OpenRouter、WorkBuddy、CodeBuddy、Cline、Qoder、Gemini Code Assist、TRAE、Raccoon、ZCode、MiniMax Code、Loomy、LobsterAI |
| **半自动**（打开官方 Key 页 → 复制 → 自动捕获校验 → 一键启动） | 15 | Groq、DeepSeek、Gemini、SiliconFlow、NVIDIA、Cerebras、Mistral、Together、Fireworks、xAI、Moonshot、Z.ai、MiniMax、OpenCode Zen、Vercel |
| **完全免密** | 4 | Kilo 免费池、Ollama、LM Studio、llama.cpp |

合计 30 个渠道（OpenRouter 同时属于"一键"与预设；WorkBuddy / CodeBuddy 是两个独立渠道实例）。

---

## 二、十一个一键渠道的实现方式

每个渠道用的是**它自己官方开放的授权协议**，没有任何一个靠自动化网页表单。

| 渠道 | 协议 | 是否需要本机端口 | 实测 |
| --- | --- | --- | --- |
| **OpenRouter** | OAuth PKCE + localhost 回调 | 是（任意端口） | 授权页 200，回调链路完整 |
| **WorkBuddy** | 桌面端 `plugin/auth/state` 轮询 | 否 | 返回真实 state + authUrl |
| **CodeBuddy** | 同 WorkBuddy，`platform=codebuddy` | 否 | 返回真实 state + authUrl |
| **Cline** | WorkOS **device-code** | **否** | 设备码 `VPTB-DTGG`，轮询 `authorization_pending` |
| **Qoder** | PKCE device-code | **否** | 授权页 200，轮询 404 = 待授权 |
| **Gemini Code Assist** | Google OAuth + PKCE + 回调 | 是 | 授权页到 Google 登录 |
| **TRAE** | PKCE + 固定 18080 回调 | 是（占用则回退） | 授权页 200 |
| **Raccoon** | 微信扫码 + 宿主轮询 | **否** | 自造 code 返回 `status: pending` |
| **ZCode** | 服务端中介设备授权流 | **否** | `flow_id` + `authorize_url` |
| **MiniMax Code** | 设备码 + PKCE | **否** | `user_code` `FGYP-439U` |
| **Loomy** | 短信验证码（HMAC-SHA1 签名） | **否** | 签名通过，短信真实发出 |
| **LobsterAI** | PKCE + 本机回调 | 是 | 门户 200，exchange 返回 `40102` |

### 关键实现细节

**Cline（device-code）**

```
1) POST {workos}/user_management/authorize/device  → device_code + user_code
2) 轮询 {workos}/user_management/authenticate      → access_token
3) POST {api}/api/v1/auth/register                 → Cline 自己的 token
```

两个必须记住的坑：

- `authorization_pending` **以 HTTP 400 返回**。按状态码判失败会把"用户还没点授权"误报成登录失败。
- `slow_down` 必须真的累积退避，否则会被持续限流。
- 落盘的 token **必须保留 `workos:` 前缀**——剥掉后 `/api/v1/users/me` 返回 401，且错误文案是误导性的"请升级客户端"。

**Qoder（device-code）**

- `client_id` 必须用**生产环境**那个。用非 prod 的会在回调阶段被拒，页面报"参数无效"。
- 轮询端点返回 **404 表示"尚未授权"**（对照：该 host 上任意不存在的路径返回 401，所以 404 是业务语义）。
- `machine_id` 由本机生成并持久化，参与服务端设备绑定，续期时必须回传。

**ZCode（服务端中介）**

```
1) POST /api/v1/oauth/cli/init  (Authorization 是自己生成的会话密钥) → flow_id + authorize_url
2) 用户在浏览器授权，回调发生在服务端，不需要本地端口
3) GET  /api/v1/oauth/cli/poll/{flow_id} → { status: 'ready', token, ... }
```

刻意绕开 `POST /api/v1/oauth/token`（上游长期 500 / code 2007）。第三个 token 落在
`data.bigmodel` 还是 `data.zai` 取决于登录变体，两者都做了兼容。

**MiniMax Code（device-code）**

最容易踩的坑：**`pending` 是 HTTP 200 + `status: "pending"`**，不是标准的
`400 + error=authorization_pending`。只认标准形态会立刻抛错，用户来不及授权。
两种形态都认。凭据校验很严：`token_type` 必须是 Bearer、`expires_in` 必须为正、
`scope` 必须含 `agent.default`。

**Loomy（短信登录）**

唯一没有"打开链接"这一步的渠道。签名是 **9 段换行拼接**的 HMAC-SHA1：

```
POST \n ESCAPED_PATH \n ESCAPED_QUERY \n CONTENT_MD5 \n
CONTENT_TYPE \n DATE \n NONCE \n SIGNED_HEADERS \n CANONICALIZED_HEADERS
```

后两段恒为空，所以待签串**以两个换行结尾**——去掉就签名失败。`Date` 必须是 UTC 字符串、
`Nonce` 是 UUID，两者也要作为请求头发出去（服务端据此重算）。请求体必须**序列化一次**，
签名与发送共用同一个字符串，二次序列化会改变字节。

**Raccoon（扫码）**

Raccoon **不是** OAuth 渠道：桌面端走 `office-raccoon://auth/callback`，Node 收不到；
`/code/authorize` 的回调地址写死，指向 localhost 会返回"授权链接无效"（已在真实浏览器验证）。

可行的是 Web 扫码流程，**不需要回调**：宿主自己生成 32 位 hex 的 `qrcode_code` →
用户微信扫码 → 宿主轮询 `login_with_qrcode_code`。实测自造 code 返回
`{"code":0,"data":{"status":"pending"}}`，正是"等待扫码"状态。

二维码是**自己实现的编码器**（`src/core/qr.js`，零依赖），并用独立解码器做往返校验。

**WorkBuddy / CodeBuddy（同源双实例）**

两者协议相同、端点不同：

| | WorkBuddy | CodeBuddy |
| --- | --- | --- |
| 端点 | `www.workbuddy.ai` | `copilot.tencent.com` |
| platform | `workbuddy-ai` | `codebuddy` |
| UA | `WorkBuddy/5.8.4` | `CodeBuddyIDE/1.106.1` |

共用 `WorkBuddyChannel` 运行时，靠配置里的 `platform` 与 `options` 区分。

---

## 三、为什么其余 15 家不能一键

### 3.1 参考项目是怎么做的（重要更正）

我最初以为 `dsh-our-free-model` 的账号渠道是靠自动化网页表单，**核对源码后发现不是**。
它的 `vendor/channel-pack/src/*-oauth.ts` 用的全是官方授权协议：

| 模块 | 实际用的流程 |
| --- | --- |
| `cline-oauth.ts` | WorkOS **device-code** |
| `gemini-oauth.ts` | **Google OAuth** + localhost 回调 + refresh_token |
| `trae-oauth.ts` | **PKCE** + `127.0.0.1` 回调 |
| `qoder-oauth.ts` | PKCE 授权码 + `redirect_uri` |
| `raccoon-oauth.ts` | 自造扫码 code + 轮询 |

它没有任何一处用无头浏览器去点"Create API Key"。上面这些账号渠道的移植正是照这个思路做的。

### 3.2 实测：这 15 个 Key 页面能不能直接驱动

用无头 Chrome 逐个加载（并去掉 `AutomationControlled` 特征），记录最终落点：

| 渠道 | 最终落到 | 页面特征 |
| --- | --- | --- |
| Groq | console.groq.com/keys | 未登录仅 342 字符 |
| DeepSeek | platform.deepseek.com/**sign_in** | 登录墙 |
| NVIDIA | build.nvidia.com/settings/api-keys | 有 "Create an Account" |
| Cerebras | cloud.cerebras.ai | 空白（需登录后渲染） |
| Fireworks | app.fireworks.ai/**login** | 登录墙 |
| Moonshot | platform.kimi.ai/**login** | 登录墙 |
| Z.ai | chat.z.ai/**auth**（OAuth） | 空白 |
| MiniMax | account.minimax.io/**unified-login** | 空白 |
| Together | api.together.ai/**signin** | 登录墙 |
| Vercel | vercel.com/**login** | 登录墙 |
| OpenRouter | openrouter.ai/**sign-in** | 登录墙 |
| Gemini | accounts.google.com/**signin** | 登录表单 |
| SiliconFlow | account.siliconflow.com/**login** | 登录墙 |
| xAI | console.x.ai（Cloudflare） | 拦截页 |
| Mistral | v2.auth.mistral.ai/**login** | 登录墙 |

**15 个里 8 个直接跳登录墙，其余未登录时不渲染可操作内容；没有一个能在不登录的情况下到达"创建 Key"。**

要自动点按钮，就必须先替用户登录——持有其账号密码或已登录 Cookie。
这不是技术难度问题，而是安全与条款取舍：这些服务商都没有提供面向第三方应用的
Key 创建 API（我也核查了 OIDC 发现文档，DeepSeek / Moonshot / 智谱 / MiniMax /
SiliconFlow / Cerebras 全部缺失）。

因此这 15 家用"打开官方页 + 剪贴板自动捕获 + 真实对话校验"的半自动流程。

---

## 四、半自动流程具体做了什么

```
选择预设
  → 「打开官方 Key 页面」（新标签，官方地址，不经过任何中转）
  → 用户登录并创建 Key，点「复制」
  → 本机读取剪贴板，识别出 Key（无需粘贴）
  → 后端用 1 token 的对话请求真实校验
  → 校验通过 → 写入渠道 → 提供「立即启动反代」
```

### 剪贴板自动捕获

点完「打开官方 Key 页面」后，控制台开始轮询剪贴板（每 1.5 秒）。
你复制 Key 的一瞬间它就被填入并自动校验，**不需要手动粘贴**。

- 由**服务端**读取剪贴板（`src/core/clipboard.js`）：Windows 走 PowerShell
  `Get-Clipboard`（显式设 UTF-8，否则中文乱码），macOS 走 `pbpaste`，
  Linux 依次尝试 `wl-paste` / `xclip` / `xsel`。
- 接口**只返回通过形状检查的 Key 候选**，绝不回显剪贴板原文。
- 识别范围：裸 Key、带引号的 Key、`GROQ_API_KEY=…` 这类 `.env` 片段、
  以及夹在说明文字里的 Key。
- 真正的判定仍是**对话探测**——形状检查只负责"这像不像一个 Key"。
- 复选框可随时关闭；读不到剪贴板时退回手动粘贴。

**这是合法的自动化**：只读本机剪贴板，不接触用户账号，不代替用户登录。

### 关键设计：校验用对话端点，不是模型列表

实测 NVIDIA、Vercel、OpenRouter 的 `GET /models` 对匿名请求返回 200：

| 渠道 | `GET /models` 匿名 | `POST /chat/completions` 匿名 |
| --- | --- | --- |
| NVIDIA NIM | 200（81 个模型） | 401 |
| Vercel AI Gateway | 200（477 个模型） | 401 |
| OpenRouter | 200（468 个模型） | 401 |

只看模型列表会把无效 Key 判成可用。校验逻辑：

- `max_tokens: 1` 的真实对话请求
- **401/403** → Key 无效（明确报错，附官方 Key 页面）
- **402/429** → Key 有效但没额度 / 被限流（算通过，带警告）
- **400 + "model not found"** → 只有模型列表也读成功时才算通过
- **5xx / 超时** → 报连接错误，不误判 Key

---

## 五、免密渠道

| 渠道 | 实测 |
| --- | --- |
| Kilo.ai 免费池 | `GET /models` 200（400 个模型），对话 200，无需任何凭据 |
| Ollama / LM Studio / llama.cpp | 探测 `127.0.0.1` 对应端口；服务没启动时明确报错 |

Kilo 免费池的上游声明提示可能被记录用于改进服务，控制台与 README 都保留了这条提醒。

---

## 六、接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/connect/presets` | 30 个渠道及其连接策略 |
| GET | `/admin/connect/local?preset=ollama` | 探测本机运行时 |
| GET | `/admin/connect/clipboard` | 读取剪贴板中的 Key 候选（只返回形状检查通过的） |
| POST | `/admin/connect/verify` | 用真实对话校验 Key（不落盘） |
| POST | `/admin/connect/oauth/start` | 发起授权，返回 `mode` / `authUrl` / `userCode` / `qrSvg` |
| POST | `/admin/connect/oauth/submit` | 提交短信验证码（Loomy） |
| GET | `/admin/connect/oauth/status` | 轮询授权结果；成功时自动建渠道并写入凭据 |
| POST | `/admin/connect/oauth/refresh` | 用 refresh_token 续期 |

`oauth/start` 返回的 `mode` 决定控制台怎么呈现：

- `device-code` → 显示设备码 + 授权链接（Cline、Qoder、ZCode、MiniMax）
- `loopback` → 打开授权页，本机端口接收回调（OpenRouter、Gemini、TRAE、LobsterAI）
- `qr` → 渲染服务端生成的 SVG 二维码（Raccoon）
- `sms` → 渲染手机号 + 验证码表单（Loomy）

WorkBuddy / CodeBuddy 走渠道自己的 `/admin/login/*` 接口，不走 OAuth registry。

---

## 七、安全设计

- **state 一次性**：10 分钟过期，未知 state 一律拒绝，不能注入凭据。
- **凭据只交付一次**：轮询成功后 session 立即销毁，重复查询报"不存在或已过期"。
- **回调只监听 `127.0.0.1`**，退出时自动关闭。
- **token 不出现在任何 API 响应里**：`status()` / `describe()` 只给掩码与 `hasToken`。
- **二维码不经过第三方**：SVG 在服务端生成，扫码用的 code 只留在本机。
- **不持有用户账号**：所有登录都在用户自己的浏览器完成。

---

## 八、如何验证

```bash
npm run check        # 语法（59 个文件）
npm test             # 7 个测试套件
npm run test:ui      # 无头浏览器：向导渲染、设备码、二维码、一键启动
npm run test:live    # 真实 Key 页面与免密渠道探测
npm run test:live-auth   # 十个账号渠道的真实授权探测（不完成登录）
```

测试覆盖：

- `oauth-test.mjs`：十个 provider 的完整流程（pending / slow_down / 404 / state 隔离 /
  凭据一次性 / token 前缀保留）
- `qr-test.mjs`：用**独立解码器**往返校验二维码，含 RS 纠错与损坏检测
- `account-test.mjs`：账号渠道的 token 传输、模型发现、校验、账号管理、不泄露
- `e2e-oauth-test.mjs`：授权 → 凭据落盘 → 建渠道 → 启动 → 真实对话的完整链路
- `clipboard-test.mjs`：各家 Key 形状识别、拒绝非 Key、`.env` 提取
- `connect-test.mjs`：Key 校验的 401/402/429 分支、本机探测
- `ui-smoke-test.mjs`：向导交互、设备码显示、二维码渲染、一键启动

---

## 九、后续扩展

某个渠道将来若开放面向应用的授权，只需：

1. 在 `src/channels/oauth/` 新增 provider（继承 `OAuthProvider`，实现 `start` / `poll`）；
2. 在 `src/channels/oauth/index.js` 注册；
3. 在 `src/channels/connect.js` 的 `CONNECT_META` 把该渠道的 `strategy` 改成 `'oauth'`；
4. 如需独立的 token 传输，在 `src/channels/account/index.js` 的 `ACCOUNT_CHANNEL_SPECS` 加一条 spec。

控制台会自动把该渠道渲染成「一键授权」，其余流程不变。
