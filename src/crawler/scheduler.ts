import { config } from "../config.js";

export class StopCrawlError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterSeconds?: number) { super(message); }
}

export class RequestScheduler {
  private lastRequestAt = 0;

  constructor(
    private readonly minDelayMs = config.REQUEST_DELAY_MIN_MS,
    private readonly maxDelayMs = config.REQUEST_DELAY_MAX_MS,
    private readonly retries = config.REQUEST_RETRIES,
  ) {}

  private async delay(): Promise<void> {
    const target = this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
    const wait = Math.max(0, this.lastRequestAt + target - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
  }

  async run<T>(operation: () => Promise<T>, classify?: (error: unknown) => { status?: number; retryAfterSeconds?: number }): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      await this.delay();
      try { return await operation(); } catch (error) {
        lastError = error;
        if (error instanceof StopCrawlError) throw error;
        const info = classify?.(error) ?? {};
        if (info.status === 403) throw new StopCrawlError("403 received; crawl stopped", 403);
        if (info.status === 429) throw new StopCrawlError("429 received; crawl stopped", 429, info.retryAfterSeconds);
        if (info.status === 401) throw new StopCrawlError("Authentication expired; crawl stopped", 401);
        if (attempt >= this.retries) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** attempt)));
      }
    }
    throw lastError;
  }
}
