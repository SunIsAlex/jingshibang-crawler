import fs from "node:fs/promises";
import path from "node:path";
import type { Page, Response } from "playwright";
import sharp from "sharp";
import { config } from "../config.js";
import { RequestScheduler, StopCrawlError } from "../crawler/scheduler.js";
import { productDetailResponseSchema, productsResponseSchema, type PaperListItem, type StoreInfo } from "../parsing/schemas.js";
import { PdfResponseCapture, type CapturedPdf } from "../pdf/pdf-capture.js";
import { PdfDocument } from "../pdf/pdf-document.js";
import type { PdfPageText } from "../pdf/text-layout.js";
import { atomicWrite, ensureDir, pathExists } from "../utils/files.js";
import { sha256 } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import { routes } from "./routes.js";
import { RequestSafetyGuard } from "./security.js";

export interface SearchOptions {
  keyword?: string;
  year?: number;
  region?: string;
  grade?: string;
  /** Subject from the "学段学科" menu, e.g. 数学. The stage (高中/初中/小学) follows from grade. */
  subject?: string;
  page?: number;
}

export interface CapturedPage {
  pageNo: number;
  localPath: string;
  sha256: string;
  width: number;
  height: number;
  cached: boolean;
  /** Embedded PDF text layer in this image's pixel coordinates; absent for canvas screenshots. */
  text?: PdfPageText;
}

export interface SavedPdf {
  localPath: string;
  sha256: string;
  byteSize: number;
  pageCount: number;
  textLayerPages: number;
  sourceUrl: string;
}

export interface OpenedPaper {
  detail: StoreInfo;
  pages: CapturedPage[];
  source: "pdf" | "canvas";
  pdf: SavedPdf | null;
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
      if (options.subject) {
        const stage = /^初/.test(options.grade ?? "") ? "初中" : /^高/.test(options.grade ?? "") || !options.grade ? "高中" : "小学";
        await this.page.getByText("学段学科").first().click();
        const menu = this.page.getByText(stage, { exact: true }).first().locator("xpath=..");
        response = await this.performAndWait("/api/products", () => menu.getByText(options.subject!, { exact: true }).first().click());
      }
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

  async openPaper(paperId: string, title: string, explicitlyRequested = false): Promise<OpenedPaper> {
    const preview = await this.loadPreview(paperId, title, explicitlyRequested, config.PREVIEW_SOURCE !== "canvas");
    if (preview.pdf) {
      try {
        const { saved, pages } = await this.processPdf(paperId, preview.pdf, true);
        logger.info("PREVIEW", { paper: paperId, source: "pdf", pages: pages.length, textLayerPages: saved.textLayerPages });
        return { detail: preview.detail, pages, source: "pdf", pdf: saved };
      } catch (error) {
        if (config.PREVIEW_SOURCE === "pdf") throw error;
        logger.warn("PDF", { paper: paperId, usable: false, message: error instanceof Error ? error.message : String(error), fallback: "canvas" });
      }
    } else if (config.PREVIEW_SOURCE === "pdf") {
      throw new Error(`The normal preview of paper ${paperId} did not deliver a raw PDF (PREVIEW_SOURCE=pdf)`);
    }
    const pages = await this.captureRenderedPages(paperId);
    logger.info("PREVIEW", { paper: paperId, source: "canvas", pages: pages.length });
    return { detail: preview.detail, pages, source: "canvas", pdf: null };
  }

  /** Save the original PDF delivered to the normal preview, without rendering pages or calling any AI. */
  async fetchPdf(paperId: string, title: string, explicitlyRequested = false): Promise<{ detail: StoreInfo; pdf: SavedPdf }> {
    const preview = await this.loadPreview(paperId, title, explicitlyRequested, true);
    if (!preview.pdf) throw new Error(`The normal preview of paper ${paperId} did not deliver a raw PDF`);
    const { saved } = await this.processPdf(paperId, preview.pdf, false);
    return { detail: preview.detail, pdf: saved };
  }

  private async loadPreview(paperId: string, title: string, explicitlyRequested: boolean, capturePdf: boolean): Promise<{ detail: StoreInfo; pdf: CapturedPdf | null }> {
    this.guard.assertKnownPaperId(paperId, explicitlyRequested);
    const url = routes.paperDetail(paperId, title); this.guard.assertAllowedRequest(url, "page");
    // Passive listener only: it reads the PDF the preview page fetches for PDF.js and never sends a request.
    const capture = new PdfResponseCapture();
    if (capturePdf) capture.attach(this.page);
    try {
      const response = await this.performAndWait(`/api/product/detail/${paperId}`, () => this.page.goto(url, { waitUntil: "domcontentloaded" }));
      const detail = productDetailResponseSchema.parse(await response.json()).data.storeInfo;
      await this.page.locator(".pdf-page canvas").first().waitFor({ state: "visible", timeout: config.BROWSER_TIMEOUT_MS });
      await this.page.waitForTimeout(1_000);
      const pdf = capturePdf ? await capture.waitForPdf(config.PDF_CAPTURE_TIMEOUT_MS) : null;
      return { detail, pdf };
    } finally { capture.detach(); }
  }

  private async processPdf(paperId: string, pdf: CapturedPdf, render: boolean): Promise<{ saved: SavedPdf; pages: CapturedPage[] }> {
    const document = await PdfDocument.open(pdf.buffer);
    try {
      const localPath = path.join(config.pdfDir, `${paperId}.pdf`);
      const unchanged = await pathExists(localPath) && sha256(await fs.readFile(localPath)) === pdf.sha256;
      if (!unchanged) await atomicWrite(localPath, pdf.buffer);
      const scale = config.PDF_RENDER_SCALE;
      const directory = path.join(config.rawPagesDir, paperId); if (render) await ensureDir(directory);
      const pages: CapturedPage[] = [];
      let textLayerPages = 0;
      for (let pageNo = 1; pageNo <= document.pageCount; pageNo += 1) {
        const text = await document.extractText(pageNo, scale);
        if (text.reliable) textLayerPages += 1;
        if (!render) continue;
        const { png, width, height } = await document.renderPage(pageNo, scale);
        const localPagePath = path.join(directory, `page-${String(pageNo).padStart(3, "0")}.png`);
        const pageHash = sha256(png);
        const cacheHit = await pathExists(localPagePath) && sha256(await fs.readFile(localPagePath)) === pageHash;
        if (!cacheHit) await fs.writeFile(localPagePath, png);
        pages.push({ pageNo, localPath: localPagePath, sha256: pageHash, width, height, cached: cacheHit, text });
        logger.info("PAGE", { page: pageNo, source: "pdf", cached: cacheHit, textLayer: text.reliable });
      }
      const saved = { localPath, sha256: pdf.sha256, byteSize: pdf.buffer.length, pageCount: document.pageCount, textLayerPages, sourceUrl: pdf.sourceUrl };
      logger.info("PDF", { paper: paperId, saved: true, cached: unchanged, pages: saved.pageCount, textLayerPages, bytes: saved.byteSize });
      return { saved, pages };
    } finally { await document.close(); }
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
