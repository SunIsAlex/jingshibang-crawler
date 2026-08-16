import fs from "node:fs/promises";
import path from "node:path";
import type { Page, Response } from "playwright";
import sharp from "sharp";
import { config } from "../config.js";
import { RequestScheduler, StopCrawlError } from "../crawler/scheduler.js";
import { productDetailResponseSchema, productsResponseSchema, type PaperListItem, type StoreInfo } from "../parsing/schemas.js";
import { ensureDir, pathExists } from "../utils/files.js";
import { sha256 } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import { routes } from "./routes.js";
import { RequestSafetyGuard } from "./security.js";

export interface SearchOptions {
  keyword?: string;
  year?: number;
  region?: string;
  grade?: string;
  page?: number;
}

export interface CapturedPage {
  pageNo: number;
  localPath: string;
  sha256: string;
  width: number;
  height: number;
  cached: boolean;
}

export class JingshibangClient {
  constructor(
    private readonly page: Page,
    private readonly guard: RequestSafetyGuard,
    private readonly scheduler = new RequestScheduler(),
  ) {}

  async discover(options: SearchOptions): Promise<PaperListItem[]> {
    let response: Response;
    if (options.keyword) {
      const url = routes.search(options.keyword); this.guard.assertAllowedRequest(url, "page");
      response = await this.performAndWait("/api/products", () => this.page.goto(url, { waitUntil: "domcontentloaded" }));
    } else {
      this.guard.assertAllowedRequest(routes.home, "page");
      response = await this.performAndWait("/api/products", () => this.page.goto(routes.home, { waitUntil: "domcontentloaded" }));
      for (const label of [options.grade, options.year?.toString(), options.region].filter(Boolean) as string[]) {
        response = await this.performAndWait("/api/products", () => this.page.getByText(label, { exact: true }).first().click());
      }
    }
    if ((options.page ?? 1) > 1) {
      response = await this.performAndWait("/api/products", () => this.page.locator(".el-pager li").filter({ hasText: String(options.page) }).first().click());
    }
    const parsed = productsResponseSchema.parse(await response.json());
    for (const item of parsed.data) this.guard.registerPaperId(item.id);
    logger.info("DISCOVER", { page: options.page ?? 1, papers: parsed.data.length });
    return parsed.data;
  }

  async openPaper(paperId: string, title: string, explicitlyRequested = false): Promise<{ detail: StoreInfo; pages: CapturedPage[] }> {
    this.guard.assertKnownPaperId(paperId, explicitlyRequested);
    const url = routes.paperDetail(paperId, title); this.guard.assertAllowedRequest(url, "page");
    const response = await this.performAndWait(`/api/product/detail/${paperId}`, () => this.page.goto(url, { waitUntil: "domcontentloaded" }));
    const detail = productDetailResponseSchema.parse(await response.json()).data.storeInfo;
    await this.page.locator(".pdf-page canvas").first().waitFor({ state: "visible", timeout: config.BROWSER_TIMEOUT_MS });
    await this.page.waitForTimeout(1_000);
    const pages = await this.captureRenderedPages(paperId);
    logger.info("PREVIEW", { paper: paperId, pages: pages.length });
    return { detail, pages };
  }

  private async captureRenderedPages(paperId: string): Promise<CapturedPage[]> {
    const canvases = this.page.locator(".pdf-page canvas");
    const count = await canvases.count();
    if (!count) throw new Error("Normal preview rendered no PDF canvases");
    const directory = path.join(config.rawPagesDir, paperId); await ensureDir(directory);
    const result: CapturedPage[] = [];
    for (let index = 0; index < count; index += 1) {
      const localPath = path.join(directory, `page-${String(index + 1).padStart(3, "0")}.png`);
      const buffer = await this.readStableCanvas(canvases.nth(index));
      const pageHash = sha256(buffer);
      const cacheHit = await pathExists(localPath) && sha256(await fs.readFile(localPath)) === pageHash;
      if (!cacheHit) await fs.writeFile(localPath, buffer);
      const metadata = await sharp(buffer).metadata();
      result.push({ pageNo: index + 1, localPath, sha256: pageHash, width: metadata.width ?? 0, height: metadata.height ?? 0, cached: cacheHit });
      logger.info("PAGE", { page: index + 1, cached: cacheHit });
    }
    return result;
  }

  private async readStableCanvas(canvas: ReturnType<Page["locator"]>): Promise<Buffer> {
    let previous = "";
    let current = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      current = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL("image/png"));
      if (current === previous && current.length > 100) break;
      previous = current;
      await this.page.waitForTimeout(250);
    }
    const separator = current.indexOf(",");
    if (separator < 0) throw new Error("Rendered canvas did not produce a PNG data URL");
    return Buffer.from(current.slice(separator + 1), "base64");
  }

  private waitForApiResponse(pathname: string): Promise<Response> {
    return this.page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === "https://www.jingshibang.com" && url.pathname === pathname;
    }, { timeout: config.BROWSER_TIMEOUT_MS });
  }

  private performAndWait(pathname: string, operation: () => Promise<unknown>): Promise<Response> {
    return this.scheduler.run(async () => {
      const responsePromise = this.waitForApiResponse(pathname);
      const [response] = await Promise.all([responsePromise, operation()]);
      const status = response.status();
      if (status === 401 || status === 403 || status === 429) {
        const retryAfter = Number(response.headers()["retry-after"] ?? "");
        throw new StopCrawlError(`HTTP ${status} received from an observed endpoint; crawl stopped`, status,
          Number.isFinite(retryAfter) ? retryAfter : undefined);
      }
      if (!response.ok()) throw new Error(`Observed endpoint returned HTTP ${status}`);
      return response;
    });
  }
}
