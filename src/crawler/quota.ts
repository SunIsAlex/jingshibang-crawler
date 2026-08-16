import { config } from "../config.js";
import type { SqliteDatabase } from "../database/database.js";

function localDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export class DownloadQuotaGuard {
  constructor(private readonly db: SqliteDatabase, private readonly maximum = config.MAX_DOWNLOADS_PER_DAY) {}

  usage(date = localDate()): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM download_usage WHERE date=? AND status='success'").get(date) as { count: number };
    return row.count;
  }

  assertAllowed(resourceId: string, date = localDate()): void {
    if (this.maximum === 0) throw new Error("Automatic resource download is disabled (MAX_DOWNLOADS_PER_DAY=0)");
    const existing = this.db.prepare("SELECT status FROM download_usage WHERE date=? AND resource_id=?").get(date, resourceId);
    if (existing) throw new Error(`Resource ${resourceId} already has a download record today`);
    if (this.usage(date) >= this.maximum) throw new Error(`Daily download quota ${this.maximum} reached; STOP`);
  }

  record(resourceId: string, status: "success" | "failed", date = localDate()): void {
    this.db.prepare("INSERT INTO download_usage(date,resource_id,download_time,status) VALUES(?,?,?,?)")
      .run(date, resourceId, new Date().toISOString(), status);
  }
}

export interface VisionUsage {
  requests: number;
  images: number;
  cacheHits: number;
  verifications: number;
  formulaReviews: number;
  failed: number;
}

export class VisionBudgetGuard {
  readonly usage: VisionUsage = { requests: 0, images: 0, cacheHits: 0, verifications: 0, formulaReviews: 0, failed: 0 };
  constructor(private readonly maxRequests = config.MAX_VISION_REQUESTS_PER_RUN, private readonly maxImages = config.MAX_VISION_IMAGES_PER_RUN) {}

  assertCanRequest(imageCount: number): void {
    if (this.usage.requests + 1 > this.maxRequests) throw new Error("Vision request budget reached; checkpoint required");
    if (this.usage.images + imageCount > this.maxImages) throw new Error("Vision image budget reached; checkpoint required");
  }
  recordRequest(imageCount: number): void { this.usage.requests += 1; this.usage.images += imageCount; }
  recordCacheHit(): void { this.usage.cacheHits += 1; }
}
