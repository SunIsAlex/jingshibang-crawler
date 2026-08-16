import type { Page, Response } from "playwright";
import { logger, redactText } from "../utils/logger.js";

export interface NetworkStats { requests: number; failed: number; rateLimited: boolean }

export class NetworkObserver {
  readonly stats: NetworkStats = { requests: 0, failed: 0, rateLimited: false };
  private detachHandlers: Array<() => void> = [];

  attach(page: Page): void {
    const onRequest = () => { this.stats.requests += 1; };
    const onRequestFailed = () => { this.stats.failed += 1; };
    const onResponse = (response: Response) => {
      const status = response.status();
      if (status === 429) this.stats.rateLimited = true;
      if (status === 401 || status === 403 || status === 429) {
        logger.warn(status === 429 ? "RATE_LIMIT" : "HTTP_STOP", { status, url: redactText(response.url()) });
      }
    };
    page.on("request", onRequest); page.on("requestfailed", onRequestFailed); page.on("response", onResponse);
    this.detachHandlers.push(() => { page.off("request", onRequest); page.off("requestfailed", onRequestFailed); page.off("response", onResponse); });
  }

  detach(): void { for (const detach of this.detachHandlers.splice(0)) detach(); }
}
