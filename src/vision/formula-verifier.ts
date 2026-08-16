import path from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import { ensureDir } from "../utils/files.js";
import type { VisionExtractor } from "./extractor.js";

export class FormulaVisionVerifier {
  constructor(private readonly extractor: VisionExtractor) {}

  async verifyCenterRegion(questionCropPath: string, paperId: string, questionNo: string, page: number): Promise<{ formula: string; confidence: number; cropPath: string }> {
    const metadata = await sharp(questionCropPath).metadata();
    const width = metadata.width ?? 1; const height = metadata.height ?? 1;
    const cropHeight = Math.max(80, Math.floor(height * 0.45));
    const top = Math.max(0, Math.floor((height - cropHeight) / 2));
    const outputDir = path.join(config.formulaCropsDir, paperId); await ensureDir(outputDir);
    const cropPath = path.join(outputDir, `${paperId}-q${questionNo}-f01.png`);
    const buffer = await sharp(questionCropPath).extract({ left: 0, top, width, height: Math.min(cropHeight, height - top) }).png().toBuffer();
    await sharp(buffer).toFile(cropPath);
    const result = await this.extractor.verifyFormula(buffer, paperId, page);
    return { formula: result.stem_markdown, confidence: result.confidence, cropPath };
  }
}
