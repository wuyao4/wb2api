import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
let SERVICE = "http://127.0.0.1:8787";
const PLATFORM = "workbuddy-ai";
const DEFAULT_VERSION = "5.8.4";
const TIMEOUT_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args);

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`找不到 ${CONFIG_PATH}，请先运行 npm start 或 npm run setup`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function workbuddyChannel(config) {
  return config?.channels?.workbuddy || null;
}

function primaryAccount(config) {
  const channel = workbuddyChannel(config);
  return channel?.accounts?.find((account) => account.id === "primary") || channel?.accounts?.[0] || null;
}

function channelOptions(config) {
  return workbuddyChannel(config)?.options || config?.upstream || {};
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true });
  } else if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore" });
  } else {
    spawn("xdg-open", [url], { stdio: "ignore" });
  }
}

async function saveTokens(config, accessToken, refreshToken) {
  const source = [
    accessToken ? `Authorization: Bearer ${accessToken}` : "",
    refreshToken ? `X-Refresh-Token: ${refreshToken}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await fetch(`${SERVICE}/admin/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, channel: workbuddyChannel(config) ? "workbuddy" : undefined })
    });
    const body = await response.json();
    if (response.ok && body.ok) {
      log("登录成功，token 已自动写入 WorkBuddy2API。");
      log(`账号：${body.user?.username || body.user?.email || "未知"}`);
      log(`access token 到期：${body.token?.expiresAt || "未知"}`);
      log(`刷新令牌：${body.token?.hasRefreshToken ? "已保存" : "未获取"}`);
      return true;
    }
    log(`服务端保存失败（HTTP ${response.status}）：${JSON.stringify(body).slice(0, 300)}`);
  } catch (error) {
    log(`WorkBuddy2API 服务未响应（${error.message}），改为直接写入 config.json。`);
  }

  if (workbuddyChannel(config)) {
    const account = primaryAccount(config);
    if (account) {
      if (accessToken) account.accessToken = accessToken;
      if (refreshToken) account.refreshToken = refreshToken;
    }
  } else {
    config.upstream = config.upstream || {};
    if (accessToken) config.upstream.accessToken = accessToken;
    if (refreshToken) config.upstream.refreshToken = refreshToken;
  }
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  log("已直接写入 config.json，重启 npm start 后生效。");
  return true;
}

async function main() {
  const config = loadConfig();
  const options = channelOptions(config);
  const base = String(options.baseUrl || "https://www.workbuddy.ai").replace(/\/+$/, "");
  SERVICE = `http://127.0.0.1:${config?.server?.port || 8787}`;
  const deviceToken = primaryAccount(config)?.deviceToken || options.deviceToken || "";

  const version = options?.client?.ideVersion || DEFAULT_VERSION;
  const userAgent =
    options?.client?.userAgent || "WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0";
  const headers = {
    "X-No-Authorization": "true",
    "X-Product": options?.product || "SaaS",
    "X-Domain": options?.domain || "www.workbuddy.ai",
    "Accept": "application/json",
    "User-Agent": userAgent
  };
  if (deviceToken) headers["X-Device-Token"] = deviceToken;

  log("正在创建桌面登录会话…");
  const stateResponse = await fetch(
    `${base}/v2/plugin/auth/state?platform=${encodeURIComponent(PLATFORM)}&version=${encodeURIComponent(version)}`,
    { method: "POST", headers }
  );
  const stateBody = await stateResponse.json();
  const state = stateBody?.data?.state;
  const authUrl = stateBody?.data?.authUrl;
  if (!stateResponse.ok || stateBody?.code !== 0 || !state || !authUrl) {
    throw new Error(`创建登录会话失败：${stateBody?.code || stateResponse.status} ${stateBody?.msg || ""}`);
  }

  log("请在打开的浏览器里完成 WorkBuddy 登录。");
  log("提示：先退出桌面版 WorkBuddy，避免桌面端抢先消费这个 state。");
  openBrowser(authUrl);

  const deadline = Date.now() + TIMEOUT_MS;
  let lastNotice = 0;

  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const response = await fetch(
        `${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
        { headers }
      );
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* ignore */
      }

      const accessToken = body?.data?.accessToken || body?.data?.access_token;
      const refreshToken = body?.data?.refreshToken || body?.data?.refresh_token;
      if (body?.code === 0 && accessToken) {
        await saveTokens(config, accessToken, refreshToken);
        return;
      }

      if (body?.code && body.code !== 11217) {
        log(`等待失败：${body.code} ${body.msg || ""}`);
        return;
      }

      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        log("等待登录完成…");
      }
    } catch (error) {
      log(`轮询失败：${error.message}`);
    }
  }

  throw new Error("超时：10 分钟内没有拿到 token，请重新运行 npm run login。");
}

main().catch((error) => {
  console.error("失败：", error.message);
  process.exit(1);
});
