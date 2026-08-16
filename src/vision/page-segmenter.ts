import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import { ensureDir } from "../utils/files.js";

export interface QuestionCrop {
  path: string;
  page: number;
  index: number;
  top: number;
  height: number;
  width: number;
}

interface Band { top: number; bottom: number }

export class PageSegmenter {
  constructor(private readonly outputRoot = config.questionCropsDir) {}

  async segment(pagePath: string, paperId: string, pageNo: number): Promise<QuestionCrop[]> {
    const image = sharp(pagePath).flatten({ background: "white" }).greyscale();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const darkThreshold = 225;
    const minimumDarkRatio = 0.004;
    const occupied: boolean[] = [];
    for (let y = 0; y < info.height; y += 1) {
      let dark = 0;
      for (let x = 0; x < info.width; x += 1) if (data[y * info.width + x]! < darkThreshold) dark += 1;
      occupied[y] = dark / info.width >= minimumDarkRatio;
    }
    const bands = this.findBands(occupied, 18).filter((band) => band.bottom - band.top >= 8);
    // Keep dense exam pages to roughly 1-3 questions per vision request.
    const crops = this.groupBands(bands, info.height, 520, 140);
    const outputDir = path.join(this.outputRoot, paperId);
    await ensureDir(outputDir);
    const result: QuestionCrop[] = [];
    for (let index = 0; index < crops.length; index += 1) {
      const crop = crops[index]!;
      const top = Math.max(0, crop.top - 24);
      const height = Math.min(info.height - top, crop.bottom - top + 24);
      const outputPath = path.join(outputDir, `${paperId}-p${String(pageNo).padStart(3, "0")}-c${String(index + 1).padStart(2, "0")}.png`);
      await sharp(pagePath).extract({ left: 0, top, width: info.width, height }).png().toFile(outputPath);
      result.push({ path: outputPath, page: pageNo, index: index + 1, top, height, width: info.width });
    }
    if (result.length === 0) {
      const outputPath = path.join(outputDir, `${paperId}-p${String(pageNo).padStart(3, "0")}-c01.png`);
      await fs.copyFile(pagePath, outputPath);
      result.push({ path: outputPath, page: pageNo, index: 1, top: 0, height: info.height, width: info.width });
    }
    return result;
  }

  private findBands(rows: boolean[], mergeGap: number): Band[] {
    const raw: Band[] = [];
    let start: number | null = null;
    for (let index = 0; index <= rows.length; index += 1) {
      if (rows[index] && start === null) start = index;
      if ((!rows[index] || index === rows.length) && start !== null) { raw.push({ top: start, bottom: index }); start = null; }
    }
    const merged: Band[] = [];
    for (const band of raw) {
      const previous = merged.at(-1);
      if (previous && band.top - previous.bottom <= mergeGap) previous.bottom = band.bottom;
      else merged.push({ ...band });
    }
    return merged;
  }

  private groupBands(bands: Band[], pageHeight: number, maxHeight: number, minHeight: number): Band[] {
    if (!bands.length) return [];
    const groups: Band[] = [];
    let current = { ...bands[0]! };
    for (const band of bands.slice(1)) {
      const proposedHeight = band.bottom - current.top;
      if (proposedHeight > maxHeight && current.bottom - current.top >= minHeight) {
        groups.push(current); current = { ...band };
      } else current.bottom = band.bottom;
    }
    groups.push(current);
    const last = groups.at(-1);
    if (last && groups.length > 1 && last.bottom - last.top < minHeight) {
      const previous = groups.at(-2)!;
      previous.bottom = last.bottom;
      groups.pop();
    }
    return groups.map((group) => ({ top: Math.max(0, group.top), bottom: Math.min(pageHeight, group.bottom) }));
  }
}
