import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import { VisionBudgetGuard } from "../crawler/quota.js";
import type { SqliteDatabase } from "../database/database.js";
import { Repository } from "../database/repository.js";
import { ensureDir, pathExists } from "../utils/files.js";
import { sha256 } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import type { FigureLocation, VisionProvider } from "./provider.js";

interface CachedLocations { locations: FigureLocation[] }

export interface PixelBox { left: number; top: number; right: number; bottom: number }

export function findInkSnappedBox(
  data: Uint8Array,
  width: number,
  height: number,
  seedTop: number,
  seedBottom: number,
): PixelBox | null {
  const occupied: boolean[] = [];
  for (let y = 0; y < height; y += 1) {
    let hasInk = false;
    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x]! < 210) { hasInk = true; break; }
    }
    occupied[y] = hasInk;
  }
  const bands: Array<{ top: number; bottom: number }> = [];
  let start: number | null = null; let lastInk = -1;
  for (let y = 0; y <= height; y += 1) {
    if (occupied[y]) { start ??= y; lastInk = y; }
    if (start !== null && (y === height || y - lastInk > 8)) {
      if (lastInk - start + 1 >= 40) bands.push({ top: start, bottom: lastInk + 1 });
      start = null;
    }
  }
  const overlap = (band: { top: number; bottom: number }) => Math.max(0, Math.min(seedBottom, band.bottom) - Math.max(seedTop, band.top));
  const band = bands.sort((a, b) => overlap(b) - overlap(a))[0];
  if (!band || overlap(band) <= 0) return null;
  let left = width; let right = -1;
  for (let y = band.top; y < band.bottom; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x]! < 210) { left = Math.min(left, x); right = Math.max(right, x); }
    }
  }
  return right < left ? null : { left, top: band.top, right: right + 1, bottom: band.bottom };
}

export interface FigureRefineSummary {
  questions: number;
  refined: number;
  preserved: number;
  assets: number;
  visionRequests: number;
  cacheHits: number;
}

export class FigureAssetRefiner {
  private readonly repository: Repository;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly provider: VisionProvider,
    private readonly budget = new VisionBudgetGuard(),
  ) {
    this.repository = new Repository(db);
  }

  async refinePaper(remoteId: string): Promise<FigureRefineSummary> {
    if (!this.provider.locateFigures) throw new Error(`Vision provider ${this.provider.model} does not support figure location`);
    const candidates = this.repository.listPaperImageCandidates(remoteId);
    const summary: FigureRefineSummary = { questions: candidates.length, refined: 0, preserved: 0,
      assets: 0, visionRequests: 0, cacheHits: 0 };
    for (const candidate of candidates) {
      const sourcePages = [...new Set((JSON.parse(candidate.source_pages) as number[]).filter(Number.isInteger))].slice(0, 3);
      const pagePaths = sourcePages.map((page) => path.join(config.rawPagesDir, remoteId, `page-${String(page).padStart(3, "0")}.png`));
      if (!pagePaths.length || !(await Promise.all(pagePaths.map(pathExists))).every(Boolean)) {
        logger.warn("FIGURE", { q: candidate.question_no, action: "preserve", reason: "source-page-missing" });
        summary.preserved += 1; continue;
      }
      const pageBuffers = await Promise.all(pagePaths.map((pagePath) => fs.readFile(pagePath)));
      const imageHash = sha256(Buffer.concat(pageBuffers.flatMap((buffer) => [Buffer.from(String(buffer.length)), buffer])));
      const questionHash = sha256(candidate.stem_markdown);
      const promptVersion = `${config.VISION_PROMPT_VERSION}:figure-v1`;
      let locations = this.getCache(imageHash, questionHash, promptVersion);
      if (locations) { this.budget.recordCacheHit(); summary.cacheHits += 1; }
      else {
        this.budget.assertCanRequest(pageBuffers.length);
        this.budget.recordRequest(pageBuffers.length); summary.visionRequests += 1;
        locations = await this.provider.locateFigures(pageBuffers, {
          paperId: remoteId, questionNo: candidate.question_no,
          stemMarkdown: candidate.stem_markdown, promptVersion,
        });
        this.putCache(imageHash, questionHash, promptVersion, locations);
      }
      const valid = locations.filter((location) => location.confidence >= 0.72 && location.imageIndex < pageBuffers.length);
      const assets = [];
      for (let index = 0; index < valid.length; index += 1) {
        const location = valid[index]!;
        const buffer = await this.cropFigure(pageBuffers[location.imageIndex]!, location);
        if (!buffer) continue;
        const assetHash = sha256(buffer); const localPath = path.join(config.assetsDir, `${assetHash}.png`);
        await ensureDir(config.assetsDir); if (!await pathExists(localPath)) await fs.writeFile(localPath, buffer);
        assets.push({ localPath, sha256: assetHash, mimeType: "image/png" });
      }
      if (!assets.length) {
        logger.warn("FIGURE", { q: candidate.question_no, action: "preserve", reason: "no-valid-bbox" });
        summary.preserved += 1; continue;
      }
      this.repository.replaceQuestionAssets(candidate.question_id, assets);
      summary.refined += 1; summary.assets += assets.length;
      logger.info("FIGURE", { q: candidate.question_no, refined: true, assets: assets.length });
    }
    return summary;
  }

  private async cropFigure(page: Buffer, location: FigureLocation): Promise<Buffer | null> {
    const { data, info } = await sharp(page).flatten({ background: "white" }).greyscale().raw()
      .toBuffer({ resolveWithObject: true });
    const width = info.width; const height = info.height;
    const [, seedY1, , seedY2] = location.bbox1000;
    const seedTop = Math.floor(seedY1 / 1_000 * height); const seedBottom = Math.ceil(seedY2 / 1_000 * height);
    const snapped = findInkSnappedBox(data, width, height, seedTop, seedBottom);
    if (!snapped) return null;
    const padding = 12;
    const left = Math.max(0, snapped.left - padding);
    const top = Math.max(0, snapped.top - padding);
    const right = Math.min(width, snapped.right + padding);
    const bottom = Math.min(height, snapped.bottom + padding);
    const cropWidth = right - left; const cropHeight = bottom - top;
    const areaRatio = cropWidth * cropHeight / Math.max(1, width * height);
    if (cropWidth < 40 || cropHeight < 40 || areaRatio < 0.001 || areaRatio > 0.65) return null;
    return sharp(page).extract({ left, top, width: cropWidth, height: cropHeight })
      .flatten({ background: "white" }).png().toBuffer();
  }

  private getCache(imageHash: string, questionHash: string, promptVersion: string): FigureLocation[] | null {
    const row = this.db.prepare(`SELECT result_json FROM figure_location_cache
      WHERE image_hash=? AND question_hash=? AND model=? AND prompt_version=?`)
      .get(imageHash, questionHash, this.provider.model, promptVersion) as { result_json: string } | undefined;
    return row ? (JSON.parse(row.result_json) as CachedLocations).locations : null;
  }

  private putCache(imageHash: string, questionHash: string, promptVersion: string, locations: FigureLocation[]): void {
    this.db.prepare(`INSERT INTO figure_location_cache(image_hash,question_hash,model,prompt_version,result_json,created_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(image_hash,question_hash,model,prompt_version) DO UPDATE SET
      result_json=excluded.result_json,created_at=excluded.created_at`)
      .run(imageHash, questionHash, this.provider.model, promptVersion, JSON.stringify({ locations }), new Date().toISOString());
  }
}
