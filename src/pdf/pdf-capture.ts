import type { Page, Response } from "playwright";
import { sha256 } from "../utils/hash.js";
import { logger, redactText } from "../utils/logger.js";

export interface CapturedPdf {
  buffer: Buffer;
  sha256: string;
  /** Source URL with temporary credentials removed. Never persist the raw URL. */
  sourceUrl: string;
}

interface PartialPdf { url: string; total: number; chunks: Array<{ start: number; buffer: Buffer }> }

export function isPdfBuffer(buffer: Buffer): boolean {
  // The PDF header may be preceded by up to 1 KiB of junk.
  return buffer.subarray(0, 1_024).includes("%PDF-");
}

export function parseContentRange(header: string | undefined): { start: number; end: number; total: number } | null {
  const match = header?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  const [start, end, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return end >= start && total > end ? { start, end, total } : null;
}

/** Join HTTP 206 chunks; returns null until every byte of the file has been observed. */
export function assembleRanges(total: number, chunks: Array<{ start: number; buffer: Buffer }>): Buffer | null {
  const output = Buffer.alloc(total);
  let covered = 0;
  for (const chunk of [...chunks].sort((a, b) => a.start - b.start)) {
    if (chunk.start > covered) return null;
    const end = Math.min(total, chunk.start + chunk.buffer.length);
    if (end > covered) { chunk.buffer.copy(output, covered, covered - chunk.start, end - chunk.start); covered = end; }
  }
  return covered === total ? output : null;
}

export function safeSourceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|sign|signature|expires|credential|session|auth|key/i.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return redactText(url.toString());
  } catch { return "[unparseable-url]"; }
}

/**
 * Passively records the PDF bytes that the normal preview page already downloads for PDF.js.
 * It never issues a request of its own, so it cannot add traffic or consume download quota.
 */
export class PdfResponseCapture {
  private readonly complete: CapturedPdf[] = [];
  private readonly partial = new Map<string, PartialPdf>();
  private readonly reads = new Set<Promise<void>>();
  private page: Page | null = null;
  private readonly onResponse = (response: Response) => {
    if (!this.isCandidate(response)) return;
    const read = this.read(response).finally(() => this.reads.delete(read));
    this.reads.add(read);
  };

  attach(page: Page): void { this.page = page; page.on("response", this.onResponse); }

  detach(): void { this.page?.off("response", this.onResponse); this.page = null; }

  /** Wait until a complete PDF has been observed, or give up after timeoutMs. */
  async waitForPdf(timeoutMs: number): Promise<CapturedPdf | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await Promise.allSettled([...this.reads]);
      const best = this.best();
      if (best || Date.now() >= deadline) return best;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private isCandidate(response: Response): boolean {
    const status = response.status();
    if ((status !== 200 && status !== 206) || response.request().method() !== "GET") return false;
    const type = response.headers()["content-type"] ?? "";
    let pathname = "";
    try { pathname = new URL(response.url()).pathname; } catch { return false; }
    return /pdf|octet-stream/i.test(type) || /\.pdf$/i.test(pathname) || pathname === "/api/public/filepreview";
  }

  private async read(response: Response): Promise<void> {
    const sourceUrl = safeSourceUrl(response.url());
    let body: Buffer;
    try { body = await response.body(); } catch {
      // PDF.js aborts the initial full request when the server supports ranges; the 206 chunks follow.
      logger.debug("PDF", { body: "unavailable", url: sourceUrl });
      return;
    }
    if (response.status() === 206) {
      const range = parseContentRange(response.headers()["content-range"]);
      if (!range) return;
      const key = response.url().split("?")[0]!;
      const entry = this.partial.get(key) ?? { url: sourceUrl, total: range.total, chunks: [] };
      entry.chunks.push({ start: range.start, buffer: body }); this.partial.set(key, entry);
      return;
    }
    if (isPdfBuffer(body)) {
      this.complete.push({ buffer: body, sha256: sha256(body), sourceUrl });
      logger.info("PDF", { captured: true, bytes: body.length, url: sourceUrl });
    } else if (new URL(response.url()).pathname === "/api/public/filepreview") {
      logger.info("PDF", { previewResponse: "not-a-raw-pdf", contentType: response.headers()["content-type"] ?? "", bytes: body.length });
    }
  }

  private best(): CapturedPdf | null {
    const largest = [...this.complete].sort((a, b) => b.buffer.length - a.buffer.length)[0];
    if (largest) return largest;
    for (const entry of this.partial.values()) {
      const buffer = assembleRanges(entry.total, entry.chunks);
      if (buffer && isPdfBuffer(buffer)) {
        logger.info("PDF", { captured: true, bytes: buffer.length, rangeChunks: entry.chunks.length, url: entry.url });
        const pdf = { buffer, sha256: sha256(buffer), sourceUrl: entry.url };
        this.complete.push(pdf);
        return pdf;
      }
    }
    return null;
  }
}
