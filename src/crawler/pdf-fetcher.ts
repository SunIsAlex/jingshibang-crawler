import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { createBrowserSession } from "../browser/session.js";
import { NetworkObserver } from "../browser/network-observer.js";
import { JingshibangClient, type SearchOptions } from "../jingshibang/client.js";
import { RequestSafetyGuard } from "../jingshibang/security.js";
import { ensureDir } from "../utils/files.js";
import { logger } from "../utils/logger.js";
import { StopCrawlError } from "./scheduler.js";

export interface FetchPdfOptions extends SearchOptions { paper?: string }

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * Save the original PDF of each paper by opening its normal preview page and keeping the PDF bytes
 * PDF.js already received. No AI is called, no extra request is sent and no download quota is used.
 */
export async function fetchOriginalPdfs(options: FetchPdfOptions): Promise<void> {
  const guard = new RequestSafetyGuard();
  const observer = new NetworkObserver();
  const browser = await createBrowserSession();
  const result = { saved: 0, failed: 0 };
  try {
    observer.attach(browser.page);
    const client = new JingshibangClient(browser.page, guard);
    let papers: Array<{ id: string; store_name: string }>;
    if (options.paper) { guard.registerPaperId(options.paper); papers = [{ id: options.paper, store_name: "" }]; }
    else papers = await client.discover(options);
    for (const paper of papers) {
      try {
        const { detail, pdf } = await client.fetchPdf(paper.id, paper.store_name, Boolean(options.paper));
        const outputPath = path.join(config.outputDir, paper.id, `${safeFileName(detail.store_name) || paper.id}.pdf`);
        await ensureDir(path.dirname(outputPath));
        await fs.copyFile(pdf.localPath, outputPath);
        result.saved += 1;
        console.log(`${paper.id}\t${pdf.pageCount} 页\t文字层 ${pdf.textLayerPages}/${pdf.pageCount} 页\t${outputPath}`);
      } catch (error) {
        if (error instanceof StopCrawlError || options.paper) throw error;
        result.failed += 1;
        logger.warn("PDF", { paper: paper.id, saved: false, message: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    observer.detach(); await browser.close();
    console.log("========== PDF Summary ==========");
    console.log(`网络请求：${observer.stats.requests}  保存 PDF：${result.saved}  失败：${result.failed}`);
    console.log("AI 请求：0"); console.log("资料下载额度消耗：0");
  }
}
