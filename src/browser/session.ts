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
