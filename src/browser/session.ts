import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";
import { ensureDir, pathExists } from "../utils/files.js";
import { logger } from "../utils/logger.js";
import { routes } from "../jingshibang/routes.js";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

async function launchBrowser(headless: boolean): Promise<Browser> {
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
  if (options.requireAuth !== false && !await pathExists(config.authStatePath)) {
    throw new Error(`Authentication state not found at ${config.authStatePath}. Run npm run auth first.`);
  }
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
  await browser.close();
  logger.info("AUTH", { saved: true, path: ".local/auth-state.json" });
}

/**
 * Headless login for machines without a display: saves the WeChat login QR code to qrFile
 * (refreshed whenever the site rotates it) and stores the session once the user has scanned it.
 */
export async function qrCodeLogin(qrFile: string, timeoutMs = 5 * 60_000): Promise<void> {
  const browser = await launchBrowser(true);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", deviceScaleFactor: 3 });
    const page = await context.newPage();
    await page.goto(routes.home, { waitUntil: "domcontentloaded" });
    const loginButton = page.getByText("登录", { exact: true }).first();
    const qr = page.locator("img.weixinImg").first();
    // A fresh context is logged out; wait until the SPA has rendered the login button before judging login state.
    await loginButton.waitFor({ state: "visible", timeout: config.BROWSER_TIMEOUT_MS });
    await ensureDir(path.dirname(path.resolve(qrFile)));
    let lastSource = "";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const loggedOut = await page.getByText("登录", { exact: true }).count() > 0;
      if (!loggedOut) break;
      if (!await qr.isVisible()) {
        await loginButton.click();
        await qr.waitFor({ state: "visible", timeout: config.BROWSER_TIMEOUT_MS });
      }
      const source = await qr.getAttribute("src") ?? "";
      if (source !== lastSource) {
        await page.waitForFunction((image) => (image as HTMLImageElement).complete, await qr.elementHandle());
        await qr.screenshot({ path: qrFile });
        lastSource = source;
        console.log(`请用已关注"北京题库"的微信扫描二维码：${path.resolve(qrFile)}`);
      }
      await page.waitForTimeout(2_000);
    }
    if (await page.getByText("登录", { exact: true }).count() > 0) throw new Error("Login was not completed before the QR login timed out");
    await page.waitForTimeout(2_000);
    await ensureDir(path.dirname(config.authStatePath));
    await context.storageState({ path: config.authStatePath });
    await fs.chmod(config.authStatePath, 0o600).catch(() => undefined);
    logger.info("AUTH", { saved: true, path: ".local/auth-state.json", method: "qr" });
  } finally { await browser.close(); }
}
