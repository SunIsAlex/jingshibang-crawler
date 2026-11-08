import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";
import { ensureDir, pathExists } from "../utils/files.js";
import { logger } from "../utils/logger.js";
import { routes } from "../jingshibang/routes.js";

const execFile = promisify(execFileCb);

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

interface PendingQrState {
  weChatFlag: string;
  qrUrl: string;
  createdAt: number;
}

const pendingQrPath = path.resolve(config.root, ".local/pending-qr.json");

function decodeJwtExpMs(token: string): number | null {
  try {
    const parts = token.split(".");
    if (!parts[1]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload?.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Jingshibang's frontend sets localStorage.tokenExpiresAt to only 12h even though the server JWT
 * is valid for 7 days, and deletes localStorage.token on boot if Date.now() >= tokenExpiresAt.
 * Keep tokenExpiresAt aligned with the JWT's actual exp so valid tokens aren't wiped prematurely.
 */
async function ensureFreshAuthState(authStatePath: string): Promise<void> {
  if (!(await pathExists(authStatePath))) return;
  try {
    const raw = await fs.readFile(authStatePath, "utf8");
    const state = JSON.parse(raw);
    const originEntry = state?.origins?.find((o: { origin?: string }) => o.origin === "https://www.jingshibang.com");
    const ls: Array<{ name: string; value: string }> | undefined = originEntry?.localStorage;
    if (!Array.isArray(ls)) return;
    const tokenItem = ls.find((x) => x.name === "token");
    if (!tokenItem?.value) return;
    const jwtExpMs = decodeJwtExpMs(tokenItem.value);
    if (!jwtExpMs || jwtExpMs <= Date.now() + 60_000) return;

    let changed = false;
    const expStr = String(jwtExpMs);
    const expItem = ls.find((x) => x.name === "tokenExpiresAt");
    if (!expItem) {
      ls.push({ name: "tokenExpiresAt", value: expStr });
      changed = true;
    } else if (Number(expItem.value) < jwtExpMs) {
      expItem.value = expStr;
      changed = true;
    }

    if (Array.isArray(state.cookies) && !state.cookies.some((c: { name?: string }) => c.name === "token")) {
      state.cookies.push({
        name: "token",
        value: tokenItem.value,
        domain: "www.jingshibang.com",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      });
      changed = true;
    }

    if (changed) {
      await fs.writeFile(authStatePath, JSON.stringify(state, null, 2));
      await fs.chmod(authStatePath, 0o600).catch(() => undefined);
    }
  } catch {}
}

async function curlJson<T = any>(url: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<T> {
  const args = ["-sS", "--max-time", "15"];
  if (options.method && options.method !== "GET") {
    args.push("-X", options.method);
  }
  for (const [k, v] of Object.entries(options.headers ?? {})) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push(url);
  const { stdout } = await execFile("curl", args);
  return JSON.parse(stdout) as T;
}

async function downloadFileWithCurl(url: string, destPath: string): Promise<void> {
  await ensureDir(path.dirname(path.resolve(destPath)));
  await execFile("curl", ["-sSL", "--max-time", "20", "-o", path.resolve(destPath), url]);
}

async function saveWeChatTokenToAuthState(token: string): Promise<void> {
  let userInfo: Record<string, unknown> = {};
  try {
    const userRes = await curlJson<{ status?: number; data?: Record<string, unknown> }>(
      "https://www.jingshibang.com/api/user",
      {
        headers: {
          "Authori-zation": `Bearer ${token}`,
          Authorization: `Bearer ${token}`,
        },
      }
    );
    if (userRes?.data && typeof userRes.data === "object") {
      userInfo = userRes.data;
    }
  } catch {}

  const jwtExpMs = decodeJwtExpMs(token) ?? Date.now() + 7 * 24 * 3600 * 1000;
  const authState = {
    cookies: [
      {
        name: "token",
        value: token,
        domain: "www.jingshibang.com",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [
      {
        origin: "https://www.jingshibang.com",
        localStorage: [
          { name: "token", value: token },
          { name: "tabCount", value: "1" },
          { name: "userInfo", value: JSON.stringify(userInfo) },
          { name: "tokenExpiresAt", value: String(jwtExpMs) },
        ],
      },
    ],
  };

  await ensureDir(path.dirname(config.authStatePath));
  await fs.writeFile(config.authStatePath, JSON.stringify(authState, null, 2));
  await fs.chmod(config.authStatePath, 0o600).catch(() => undefined);
  await fs.rm(pendingQrPath, { force: true }).catch(() => undefined);
  logger.info("AUTH", { saved: true, path: ".local/auth-state.json", method: "qr-api", uid: userInfo.uid });
}

export async function checkPendingQrAuth(): Promise<boolean> {
  if (!(await pathExists(pendingQrPath))) return false;
  try {
    const pending = JSON.parse(await fs.readFile(pendingQrPath, "utf8")) as PendingQrState;
    if (!pending?.weChatFlag || Date.now() - pending.createdAt > 10 * 60_000) return false;
    const res = await curlJson<{ status?: number; data?: { token?: string } }>(
      `https://www.jingshibang.com/api/wechat/pcauth2?wechat_flag=${encodeURIComponent(pending.weChatFlag)}`
    );
    if (res?.status === 200 && res.data?.token) {
      await saveWeChatTokenToAuthState(res.data.token);
      return true;
    }
  } catch {}
  return false;
}

export async function launchBrowser(headless: boolean): Promise<Browser> {
  const executablePath = config.BROWSER_EXECUTABLE_PATH.trim();
  if (executablePath) return chromium.launch({ headless, executablePath });
  const channel = config.BROWSER_CHANNEL.trim();
  try {
    return await chromium.launch({ headless, ...(channel ? { channel } : {}) });
  } catch (error) {
    if (!channel) throw error;
    logger.warn("BROWSER", { message: `Channel ${channel} unavailable; trying Playwright Chromium` });
    return chromium.launch({ headless });
  }
}

export async function createBrowserSession(options: { requireAuth?: boolean; headless?: boolean } = {}): Promise<BrowserSession> {
  if (options.requireAuth !== false) {
    await checkPendingQrAuth();
    if (!(await pathExists(config.authStatePath))) {
      throw new Error(`Authentication state not found at ${config.authStatePath}. Run npm run auth first.`);
    }
  }
  await ensureFreshAuthState(config.authStatePath);
  const browser = await launchBrowser(options.headless ?? config.HEADLESS);
  const context = await browser.newContext({
    ...(await pathExists(config.authStatePath) ? { storageState: config.authStatePath } : {}),
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
  });
  context.setDefaultTimeout(config.BROWSER_TIMEOUT_MS);
  const page = await context.newPage();
  return { browser, context, page, close: () => browser.close() };
}

export async function interactiveLogin(): Promise<void> {
  const browser = await launchBrowser(false);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
  const page = await context.newPage();
  await page.goto(routes.home, { waitUntil: "domcontentloaded" });
  console.log("请在打开的浏览器中亲自完成菁师帮登录。完成后回到终端按 Enter；不要把密码输入终端。");
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  await prompt.question(""); prompt.close();
  await ensureDir(path.dirname(config.authStatePath));
  await context.storageState({ path: config.authStatePath });
  await fs.chmod(config.authStatePath, 0o600).catch(() => undefined);
  await ensureFreshAuthState(config.authStatePath);
  await browser.close();
  logger.info("AUTH", { saved: true, path: ".local/auth-state.json" });
}

/**
 * Headless login for machines without a display: fetches the WeChat login QR code via Jingshibang's API,
 * persists weChatFlag to .local/pending-qr.json so scans are never lost across restarts, and stores
 * .local/auth-state.json once the user scans the QR code.
 */
export async function qrCodeLogin(qrFile: string, timeoutMs = 5 * 60_000): Promise<void> {
  if (await checkPendingQrAuth()) {
    console.log("已检测到先前扫码完成的登录状态，凭证已保存。");
    return;
  }

  await ensureDir(path.dirname(path.resolve(qrFile)));
  await ensureDir(path.dirname(pendingQrPath));

  let pending: PendingQrState | null = null;
  if (await pathExists(pendingQrPath)) {
    try {
      const existing = JSON.parse(await fs.readFile(pendingQrPath, "utf8")) as PendingQrState;
      if (existing?.weChatFlag && existing?.qrUrl && Date.now() - existing.createdAt < 90_000) {
        pending = existing;
      }
    } catch {}
  }

  const refreshQr = async (): Promise<PendingQrState> => {
    const res = await curlJson<{ status?: number; data?: { url?: string; weChatFlag?: string } }>(
      "https://www.jingshibang.com/api/getwxpic",
      { method: "POST" }
    );
    const qrUrl = res?.data?.url;
    const weChatFlag = res?.data?.weChatFlag;
    if (!qrUrl || !weChatFlag) {
      throw new Error(`Unexpected /api/getwxpic response: ${JSON.stringify(res)}`);
    }
    const next: PendingQrState = { weChatFlag, qrUrl, createdAt: Date.now() };
    await fs.writeFile(pendingQrPath, JSON.stringify(next, null, 2));
    await downloadFileWithCurl(qrUrl, qrFile);
    console.log(`请用已关注"北京题库"的微信扫描二维码：${path.resolve(qrFile)}`);
    return next;
  };

  if (!pending) {
    pending = await refreshQr();
  } else if (!(await pathExists(qrFile))) {
    await downloadFileWithCurl(pending.qrUrl, qrFile);
    console.log(`请用已关注"北京题库"的微信扫描二维码：${path.resolve(qrFile)}`);
  } else {
    console.log(`请用已关注"北京题库"的微信扫描二维码：${path.resolve(qrFile)}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Date.now() - pending.createdAt > 4 * 60_000) {
      pending = await refreshQr();
    }
    try {
      const res = await curlJson<{ status?: number; msg?: string; data?: { token?: string; status?: string } }>(
        `https://www.jingshibang.com/api/wechat/pcauth2?wechat_flag=${encodeURIComponent(pending.weChatFlag)}`
      );
      if (res?.status === 200 && res.data?.token) {
        await saveWeChatTokenToAuthState(res.data.token);
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2_000));
  }

  throw new Error("Login was not completed before the QR login timed out");
}
