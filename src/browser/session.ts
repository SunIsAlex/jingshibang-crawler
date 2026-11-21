import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { promisify } from "node:util";
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
  const launchArgs = headless ? [] : ["--new-window", "--window-position=80,80", "--window-size=1280,900"];
  try {
    return await chromium.launch({ headless, args: launchArgs, ...(channel ? { channel } : {}) });
  } catch (error) {
    if (!channel) throw error;
    logger.warn("BROWSER", { message: `Channel ${channel} unavailable; trying Playwright Chromium` });
    return chromium.launch({ headless, args: launchArgs });
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

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate local debugging port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function resolveBrowserExecutable(channel: string): Promise<string> {
  const candidates: string[] = [];
  const localAppData = process.env.LOCALAPPDATA ?? "";
  if (channel === "msedge") {
    candidates.push(
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    );
  } else if (channel === "chrome") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ...(localAppData ? [path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe")] : []),
    );
  }
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return chromium.executablePath();
}

async function waitForCdpReady(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Browser is still starting up.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for browser remote debugging on port ${port}`);
}

const execFileAsync = promisify(execFile);

async function launchVisibleBrowserProcess(executable: string, args: string[]): Promise<{ kill(): void }> {
  if (process.platform === "win32") {
    const escapedPath = executable.replace(/'/g, "''");
    const escapedArgs = args.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(", ");
    const psScript = `$p = Start-Process -FilePath '${escapedPath}' -ArgumentList @(${escapedArgs}) -WindowStyle Normal -PassThru; Write-Output $p.Id`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", psScript]);
    const pid = Number(stdout.trim());
    return {
      kill() {
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid); } catch { /* already exited */ }
        }
      },
    };
  }
  const child = spawn(executable, args, { stdio: "ignore", detached: false });
  return { kill: () => { if (!child.killed) child.kill(); } };
}

export async function interactiveLogin(): Promise<void> {
  const channel = config.BROWSER_CHANNEL.trim() || "chrome";
  const executable = await resolveBrowserExecutable(channel);
  const port = await getFreePort();
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "jsb-auth-"));
  console.log(`正在启动可见浏览器: ${executable}`);
  const browserProc = await launchVisibleBrowserProcess(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "--window-position=80,80",
    "--window-size=1280,900",
    routes.home,
  ]);
  const onSigint = () => { browserProc.kill(); process.exit(130); };
  process.once("SIGINT", onSigint);
  try {
    await waitForCdpReady(port);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Connected browser has no default context");
    console.log(`浏览器已打开 (${routes.home})。请在打开的浏览器中亲自完成菁师帮登录。完成后回到终端按 Enter；不要把密码输入终端。`);
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    await prompt.question(""); prompt.close();
    await ensureDir(path.dirname(config.authStatePath));
    await context.storageState({ path: config.authStatePath });
    await fs.chmod(config.authStatePath, 0o600).catch(() => undefined);
    await browser.close();
    logger.info("AUTH", { saved: true, path: ".local/auth-state.json" });
  } finally {
    process.removeListener("SIGINT", onSigint);
    browserProc.kill();
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
