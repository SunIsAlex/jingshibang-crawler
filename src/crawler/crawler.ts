import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import { createBrowserSession } from "../browser/session.js";
import { NetworkObserver } from "../browser/network-observer.js";
import { AppDatabase } from "../database/database.js";
import { Repository } from "../database/repository.js";
import { JingshibangClient, type CapturedPage, type SearchOptions } from "../jingshibang/client.js";
import { routes } from "../jingshibang/routes.js";
import { RequestSafetyGuard } from "../jingshibang/security.js";
import type { ExtractedQuestion, PaperListItem } from "../parsing/schemas.js";
import { analyzeRegion, type GreyRaster } from "../pdf/region-raster.js";
import {
  isTextOnlyEligible, linesInBand, parseTextQuestion, planQuestionRegions, regionText, type QuestionRegion, type RegionPlan,
} from "../pdf/text-layout.js";
import { atomicWrite, ensureDir, pathExists } from "../utils/files.js";
import { sha256 } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import { normalizeQuestionText } from "../utils/normalize.js";
import { VisionCache } from "../vision/cache.js";
import { VisionExtractor, type ScoredQuestion } from "../vision/extractor.js";
import type { PixelBox } from "../vision/figure-asset-refiner.js";
import { FormulaVisionVerifier } from "../vision/formula-verifier.js";
import { OpenAICompatibleVisionProvider } from "../vision/openai.js";
import { PageSegmenter } from "../vision/page-segmenter.js";
import { CheckpointStore } from "./checkpoint.js";
import { VisionBudgetGuard } from "./quota.js";

export interface CrawlOptions extends SearchOptions {
  paper?: string;
  resume?: boolean;
  dryRun?: boolean;
  refresh?: boolean;
}

interface FormulaReviewResult { cropPath: string; formula: string; confidence: number; issues: string[] }
/** pdf_text: parsed from the PDF text layer without AI; vision+pdf_text: vision with the PDF text as a hint. */
type ExtractionMethod = "pdf_text" | "vision+pdf_text" | "vision";
interface FigureRef { pagePath: string; box: PixelBox }
interface PageItem {
  buffer: Buffer; cropPath: string; textHint?: string; textQuestion?: ExtractedQuestion;
  figures: FigureRef[]; method: ExtractionMethod;
  /** Crop is exactly one question region from the PDF text plan, so crop-boundary repairs are unnecessary. */
  planned: boolean;
}
interface PageExtraction extends PageItem { scored: ScoredQuestion[] }
interface PendingSave {
  scored: ScoredQuestion; sourcePages: number[]; cropPath: string; formulaReview: FormulaReviewResult | undefined;
  method: ExtractionMethod; planned: boolean; figures: FigureRef[];
}

export function looksLikeAnswerMaterial(items: ScoredQuestion[]): boolean {
  if (items.length === 0) return false;
  const answerMarker = /参考答案|答案[:：]|【(?:详解|解析|分析)】|故选(?:项)?\s*[A-D]|正确答案/u;
  const marked = items.filter((item) => answerMarker.test(item.question.stem_markdown)).length;
  return marked >= Math.max(1, Math.ceil(items.length / 2));
}

export function assertCompleteNumericSequence(items: Array<{ scored: { question: { number: string } } }>): void {
  const numbers = items.map((item) => item.scored.question.number.trim()).filter((value) => /^\d+$/.test(value)).map(Number);
  if (numbers.length < 2 || !numbers.includes(1)) return;
  const maximum = Math.max(...numbers);
  const counts = new Map<number, number>();
  for (const number of numbers) counts.set(number, (counts.get(number) ?? 0) + 1);
  const missing = Array.from({ length: maximum }, (_, index) => index + 1).filter((number) => !counts.has(number));
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([number]) => number);
  if (missing.length || duplicates.length) {
    throw new Error(`Question sequence validation failed; missing=[${missing.join(",")}], duplicates=[${duplicates.join(",")}]`);
  }
}

export function assertChoiceOptionsComplete(items: Array<{ scored: { question: ExtractedQuestion } }>): void {
  const invalid = items.filter(({ scored }) => {
    const question = scored.question;
    if (!["single_choice", "multiple_choice"].includes(question.type)) return false;
    const labels = question.options.map((option) => option.label.trim().toUpperCase());
    return labels.length < 2 || new Set(labels).size !== labels.length;
  }).map(({ scored }) => scored.question.number);
  if (invalid.length) throw new Error(`Choice option validation failed for questions [${invalid.join(",")}]`);
}

export function continuationTextSimilarity(left: string, right: string): number {
  const simplify = (value: string) => normalizeQuestionText(value).toLowerCase()
    .replace(/\\[a-z]+/g, "").replace(/[^\p{L}\p{N}]/gu, "");
  const grams = (value: string) => {
    const normalized = simplify(value);
    const output = new Set<string>();
    for (let index = 0; index < normalized.length - 2; index += 1) output.add(normalized.slice(index, index + 3));
    return output;
  };
  const a = grams(left); const b = grams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection += 1;
  return intersection / Math.min(a.size, b.size);
}

export class Crawler {
  async run(options: CrawlOptions): Promise<void> {
    if (options.dryRun) return this.printDryRun(options);
    const database = new AppDatabase(); database.migrate();
    const repository = new Repository(database.db); const checkpoint = new CheckpointStore(database.db);
    const runId = repository.startCrawlRun();
    const guard = new RequestSafetyGuard(); const budget = new VisionBudgetGuard();
    const vision = new VisionExtractor(new OpenAICompatibleVisionProvider(), new VisionCache(database.db), budget);
    const formulaVerifier = new FormulaVisionVerifier(vision);
    const segmenter = new PageSegmenter();
    let browser: Awaited<ReturnType<typeof createBrowserSession>> | null = null;
    const observer = new NetworkObserver();
    let interrupted = false; const onInterrupt = () => { interrupted = true; logger.warn("CHECKPOINT", { reason: "SIGINT" }); };
    process.once("SIGINT", onInterrupt);
    const summary = { scannedPapers: 0, newPapers: 0, existingPapers: 0, scannedQuestions: 0,
      newQuestions: 0, duplicates: 0, updated: 0, pageCacheHits: 0, pdfPapers: 0, textOnlyQuestions: 0 };
    try {
      browser = await createBrowserSession();
      observer.attach(browser.page);
      const client = new JingshibangClient(browser.page, guard);
      let papers: PaperListItem[];
      if (options.paper) {
        guard.registerPaperId(options.paper);
        papers = [{ id: options.paper, store_name: "", add_time: "", store_type: "", store_subject: "", store_grade: "", district: "", intersection: "", have_answer: "" }];
      } else {
        const resume = options.resume ? checkpoint.load("crawl") : null;
        papers = await client.discover({ ...options, page: resume?.page ?? options.page ?? 1 });
      }
      for (const paper of papers) {
        if (interrupted) break;
        summary.scannedPapers += 1; checkpoint.save("crawl", {
          ...(options.keyword ? { keyword: options.keyword } : {}), page: options.page ?? 1, paperId: paper.id, previewPage: 0,
        });
        const opened = await client.openPaper(paper.id, paper.store_name, Boolean(options.paper));
        const detail = opened.detail;
        const contentHash = sha256(JSON.stringify({ title: detail.store_name, date: detail.add_time,
          pdf: Boolean(detail.pdf_paper), answer: Boolean(detail.pdf_answer), pages: opened.pages.map((page) => page.sha256),
          ...(opened.pdf ? { sourcePdf: opened.pdf.sha256 } : {}) }));
        const paperRecord = repository.upsertPaper({ remoteId: paper.id, title: detail.store_name, year: this.parseYear(detail.store_name),
          region: detail.district || null, grade: detail.store_grade || null, subject: detail.store_subject || null,
          examType: detail.store_type || null, sourceUrl: routes.paperDetail(paper.id, detail.store_name), contentHash });
        if (paperRecord.created) summary.newPapers += 1;
        else summary.existingPapers += 1;
        if (opened.pdf) {
          summary.pdfPapers += 1;
          repository.savePaperDocument({ paperId: paperRecord.id, kind: "preview_pdf", sourceUrl: opened.pdf.sourceUrl,
            localPath: opened.pdf.localPath, sha256: opened.pdf.sha256, byteSize: opened.pdf.byteSize,
            pageCount: opened.pdf.pageCount, textLayerPages: opened.pdf.textLayerPages });
        }
        for (const page of opened.pages) {
          repository.savePaperPage({ paperId: paperRecord.id, pageNo: page.pageNo, localPath: page.localPath,
            sha256: page.sha256, width: page.width, height: page.height });
          if (page.cached) summary.pageCacheHits += 1;
        }
        if (!options.refresh && !paperRecord.created && !paperRecord.changed && repository.paperQuestionCount(paperRecord.id) > 0) {
          logger.info("PAPER", { paper: paper.id, cached: true, reason: "content-hash-unchanged" });
          checkpoint.save("crawl", {
            ...(options.keyword ? { keyword: options.keyword } : {}), page: options.page ?? 1,
            paperId: paper.id, previewPage: opened.pages.length,
          });
          continue;
        }
        const pending: PendingSave[] = [];
        const plan = this.planFromTextLayer(opened.pages, paper.id);
        for (const page of opened.pages) {
          if (interrupted) break;
          if (plan?.answerBoundary && page.pageNo > plan.answerBoundary.pageNo) break;
          const items = await this.preparePageItems(page, paper.id, plan, segmenter);
          const pageExtractions: PageExtraction[] = [];
          let answerPageDetected = false;
          for (const item of items) {
            const scored = item.textQuestion ? [vision.score(item.textQuestion)]
              : await vision.extract([item.buffer], paper.id, page.pageNo, item.textHint);
            pageExtractions.push({ ...item, scored });
            if (looksLikeAnswerMaterial(scored)) { answerPageDetected = true; break; }
          }
          const pageQuestions = pageExtractions.flatMap((item) => item.scored);
          if (answerPageDetected || looksLikeAnswerMaterial(pageQuestions)) {
            logger.info("PREVIEW", { paper: paper.id, answerSectionAtPage: page.pageNo, action: "stop-before-persist" });
            break;
          }
          await this.repairAdjacentChoiceBoundaries(pageExtractions, vision, paper.id, page.pageNo);
          await this.repairIncompleteCrossPageChoice(pending, pageExtractions, vision, paper.id, page.pageNo);
          for (const extraction of pageExtractions) {
            let scored: ScoredQuestion[];
            if (extraction.method === "pdf_text") scored = extraction.scored;
            else try {
              scored = await vision.verifyLowConfidence([extraction.buffer], paper.id, page.pageNo, extraction.scored, extraction.textHint);
            } catch {
              logger.warn("VISION", { page: page.pageNo, verify: "failed-at-orchestrator", action: "retain-first-result-needs-review" });
              scored = extraction.scored.map((item) => ({
                ...item,
                finalConfidence: Math.min(item.finalConfidence, 0.79),
                question: { ...structuredClone(item.question),
                  uncertain_regions: [...item.question.uncertain_regions, "secondary verification failed"] },
              }));
            }
            for (const item of scored) {
              let formulaReview: FormulaReviewResult | undefined;
              if (item.formulaIssues.length > 0) {
                try {
                  const review = await formulaVerifier.verifyCenterRegion(extraction.cropPath, paper.id, item.question.number, page.pageNo);
                  formulaReview = { ...review, issues: item.formulaIssues };
                  item.finalConfidence = Math.min(item.finalConfidence, review.confidence);
                  logger.info("FORMULA", { q: item.question.number, localReview: true, confidence: review.confidence });
                } catch {
                  item.finalConfidence = Math.min(item.finalConfidence, 0.79);
                  item.question.uncertain_regions.push("local formula verification failed");
                  logger.warn("FORMULA", { q: item.question.number, localReview: "failed", action: "needs-review" });
                }
              }
              this.appendPending(pending, item, page.pageNo, extraction, formulaReview);
            }
          }
          checkpoint.save("crawl", {
            ...(options.keyword ? { keyword: options.keyword } : {}), page: options.page ?? 1, paperId: paper.id, previewPage: page.pageNo,
          });
          if (plan?.answerBoundary?.pageNo === page.pageNo) {
            logger.info("PREVIEW", { paper: paper.id, answerSectionAtPage: page.pageNo, reason: plan.answerBoundary.reason, action: "stop-after-question-regions" });
            break;
          }
        }
        if (interrupted) break;
        if (pending.length === 0) throw new Error(`No question pages were identified for paper ${paper.id}`);
        assertCompleteNumericSequence(pending);
        assertChoiceOptionsComplete(pending);
        const prepared: Array<{ item: PendingSave; assets: Array<{ localPath: string; sha256: string }> }> = [];
        for (const item of pending) prepared.push({ item, assets: await this.materializeQuestionAssets(item.scored.question, item.cropPath, item.figures) });
        const savedResults = database.db.transaction(() => {
          if (!paperRecord.created) repository.replacePaperSources(paperRecord.id);
          return prepared.map(({ item, assets }) => {
            const saved = repository.saveQuestion(paperRecord.id, item.scored.question, item.sourcePages, item.cropPath,
              item.scored.finalConfidence, assets.map((asset) => asset.sha256), item.method);
            for (const asset of assets) repository.saveAsset({ questionId: saved.id, localPath: asset.localPath, sha256: asset.sha256, mimeType: "image/png" });
            if (item.formulaReview) repository.saveFormulaReview({ questionId: saved.id, cropPath: item.formulaReview.cropPath,
              formulaMarkdown: item.formulaReview.formula, confidence: item.formulaReview.confidence, issues: item.formulaReview.issues });
            return { item, saved };
          });
        })();
        for (const { item, saved } of savedResults) {
          summary.scannedQuestions += 1;
          if (saved.duplicate) summary.duplicates += 1; else summary.newQuestions += 1;
          if (item.method === "pdf_text") summary.textOnlyQuestions += 1;
          logger.info("QUESTION", { number: item.scored.question.number, method: item.method, duplicate: saved.duplicate, hash: saved.contentHash.slice(0, 12) });
        }
      }
      if (!interrupted) checkpoint.clear("crawl");
      await atomicWrite(`${config.dataDir}/last-run-summary.json`, JSON.stringify({ ...summary, network: observer.stats, vision: budget.usage, downloads: 0 }, null, 2));
      repository.finishCrawlRun(runId, {
        newPapers: summary.newPapers, newQuestions: summary.newQuestions, updatedQuestions: summary.updated,
        duplicateQuestions: summary.duplicates, networkRequests: observer.stats.requests,
        cacheHits: summary.pageCacheHits, visionRequests: budget.usage.requests,
        visionCacheHits: budget.usage.cacheHits, failedRequests: observer.stats.failed + budget.usage.failed,
      });
      this.printSummary(summary, observer.stats, budget.usage, interrupted ? "STOPPED" : "SUCCESS");
    } catch (error) {
      repository.finishCrawlRun(runId, {
        newPapers: summary.newPapers, newQuestions: summary.newQuestions, updatedQuestions: summary.updated,
        duplicateQuestions: summary.duplicates, networkRequests: observer.stats.requests,
        cacheHits: summary.pageCacheHits, visionRequests: budget.usage.requests,
        visionCacheHits: budget.usage.cacheHits, failedRequests: observer.stats.failed + budget.usage.failed + 1,
      });
      await atomicWrite(`${config.dataDir}/last-run-summary.json`, JSON.stringify({ ...summary, network: observer.stats,
        vision: budget.usage, downloads: 0, status: "FAILED" }, null, 2));
      throw error;
    } finally {
      process.removeListener("SIGINT", onInterrupt); observer.detach(); if (browser) await browser.close(); database.close();
    }
  }

  private appendPending(pending: PendingSave[], scored: ScoredQuestion, page: number, source: PageItem,
    formulaReview?: FormulaReviewResult): void {
    const previous = pending.at(-1);
    const question = scored.question;
    const previousPage = previous?.sourcePages.at(-1);
    const sameNumber = previous?.scored.question.number === question.number;
    const continuationNumber = /^(?:continuation|continued|unknown|续|接上页|\?)$/i.test(question.number.trim());
    const semanticContinuation = Boolean(previous && previousPage !== page && previous.scored.question.continues_on_next_page
      && continuationTextSimilarity(previous.scored.question.stem_markdown, question.stem_markdown) >= 0.2);
    const shouldMerge = Boolean(previous && (
      (sameNumber && (question.continues_from_previous_page || previous.scored.question.continues_on_next_page || previousPage !== page))
      || (question.continues_from_previous_page && continuationNumber)
      || semanticContinuation
    ));
    if (shouldMerge && previous) {
      const target = previous.scored.question;
      let continuationStem = question.stem_markdown;
      if (semanticContinuation) {
        const paragraphs = continuationStem.split(/\n+/);
        if (paragraphs[0] && continuationTextSimilarity(target.stem_markdown, paragraphs[0]) >= 0.2) paragraphs.shift();
        continuationStem = paragraphs.join("\n").trim();
      }
      target.stem_markdown = `${target.stem_markdown}${continuationStem ? `\n${continuationStem}` : ""}`.trim();
      target.options.push(...question.options); target.images.push(...question.images);
      target.uncertain_regions.push(...question.uncertain_regions); target.continues_on_next_page = question.continues_on_next_page;
      previous.scored.finalConfidence = Math.min(previous.scored.finalConfidence, scored.finalConfidence);
      if (!previous.sourcePages.includes(page)) previous.sourcePages.push(page);
      previous.formulaReview ??= formulaReview;
      if (previous.method !== source.method) previous.method = "vision+pdf_text";
      previous.planned &&= source.planned;
      previous.figures.push(...source.figures);
    } else {
      pending.push({ scored: { ...scored, question: structuredClone(question) }, sourcePages: [page], cropPath: source.cropPath,
        formulaReview, method: source.method, planned: source.planned, figures: [...source.figures] });
    }
  }

  private async repairIncompleteCrossPageChoice(
    pending: PendingSave[],
    pageExtractions: PageExtraction[],
    vision: VisionExtractor,
    paperId: string,
    page: number,
  ): Promise<void> {
    const previous = pending.at(-1); const first = pageExtractions[0];
    if (!previous || !first || previous.sourcePages.at(-1) === page) return;
    const question = previous.scored.question;
    if (!["single_choice", "multiple_choice"].includes(question.type)) return;
    // Text-planned regions already carry cross-page continuations explicitly.
    if (previous.planned && first.planned && question.options.length >= 2) return;
    const firstNumber = first.scored.map((item) => item.question.number).find((value) => /^\d+$/.test(value));
    const consecutiveBoundary = firstNumber !== undefined && Number(firstNumber) === Number(question.number) + 1;
    if (question.options.length >= 2 && !consecutiveBoundary) return;
    const previousBuffer = await fs.readFile(previous.cropPath);
    const crossPage = await vision.extract([previousBuffer, first.buffer], paperId, page);
    const repaired = crossPage.find((item) => item.question.number === question.number && item.question.options.length >= 2);
    if (!repaired) {
      previous.scored.finalConfidence = Math.min(previous.scored.finalConfidence, 0.79);
      previous.scored.question.uncertain_regions.push("cross-page options require manual review");
      return;
    }
    previous.scored = repaired;
    if (!previous.sourcePages.includes(page)) previous.sourcePages.push(page);
    logger.info("VISION", { page, q: question.number, crossPageRepair: true, options: repaired.question.options.length });
  }

  private async repairAdjacentChoiceBoundaries(
    extractions: PageExtraction[],
    vision: VisionExtractor,
    paperId: string,
    page: number,
  ): Promise<void> {
    for (let index = 0; index < extractions.length - 1; index += 1) {
      const current = extractions[index]!; const next = extractions[index + 1]!;
      if (current.planned && next.planned) continue;
      const candidate = current.scored.at(-1);
      if (!candidate || !["single_choice", "multiple_choice"].includes(candidate.question.type)) continue;
      if (candidate.question.options.length >= 2 && !candidate.question.continues_on_next_page) continue;
      const combined = await vision.extract([current.buffer, next.buffer], paperId, page);
      const repaired = combined.find((item) => item.question.number === candidate.question.number && item.question.options.length >= 2);
      if (repaired) {
        current.scored[current.scored.length - 1] = repaired;
        logger.info("VISION", { page, q: candidate.question.number, adjacentCropRepair: true, options: repaired.question.options.length });
      }
    }
  }

  private async materializeQuestionAssets(question: ExtractedQuestion, cropPath: string, figures: FigureRef[]): Promise<Array<{ localPath: string; sha256: string }>> {
    if (question.images.length === 0) return [];
    // Prefer exact figure boxes found by masking PDF text; otherwise keep the whole question crop as before.
    const buffers = figures.length
      ? await Promise.all(figures.map(({ pagePath, box }) => sharp(pagePath)
        .extract({ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }).png().toBuffer()))
      : [await fs.readFile(cropPath)];
    await ensureDir(config.assetsDir);
    const assets: Array<{ localPath: string; sha256: string }> = [];
    for (const buffer of buffers) {
      const imageHash = sha256(buffer);
      const localPath = path.join(config.assetsDir, `${imageHash}.png`);
      if (!await pathExists(localPath)) await fs.writeFile(localPath, buffer);
      if (!assets.some((asset) => asset.sha256 === imageHash)) assets.push({ localPath, sha256: imageHash });
    }
    question.images.forEach((image, index) => { image.path = assets[Math.min(index, assets.length - 1)]!.localPath; });
    return assets;
  }

  private planFromTextLayer(pages: CapturedPage[], paperId: string): RegionPlan | null {
    if (config.PDF_TEXT_MODE === "off") return null;
    const texts = pages.flatMap((page) => page.text ? [page.text] : []);
    if (texts.length === 0) return null;
    const plan = planQuestionRegions(texts);
    logger.info("PDF_TEXT", { paper: paperId, textPages: plan.plannedPages.size, regions: plan.regions.length,
      answerBoundaryPage: plan.answerBoundary?.pageNo ?? null });
    return plan.regions.length > 0 ? plan : null;
  }

  private async preparePageItems(page: CapturedPage, paperId: string, plan: RegionPlan | null, segmenter: PageSegmenter): Promise<PageItem[]> {
    const text = config.PDF_TEXT_MODE !== "off" && page.text?.reliable ? page.text : undefined;
    if (!plan || !text || !plan.plannedPages.has(page.pageNo)) {
      // No usable text plan for this page: segment the image; still pass any reliable PDF text as a hint.
      const crops = await segmenter.segment(page.localPath, paperId, page.pageNo);
      return Promise.all(crops.map(async (crop): Promise<PageItem> => {
        const hint = text ? linesInBand(text.lines, crop.top, crop.top + crop.height).map((line) => line.text).join("\n") : "";
        return { buffer: await fs.readFile(crop.path), cropPath: crop.path, figures: [], planned: false,
          ...(hint ? { textHint: hint, method: "vision+pdf_text" as const } : { method: "vision" as const }) };
      }));
    }
    const { data, info } = await sharp(page.localPath).flatten({ background: "white" }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const raster: GreyRaster = { data, width: info.width, height: info.height };
    const directory = path.join(config.questionCropsDir, paperId); await ensureDir(directory);
    const items: PageItem[] = [];
    for (const region of plan.regions.filter((candidate) => candidate.pageNo === page.pageNo)) {
      const analysis = analyzeRegion(raster, region, region.lines.flatMap((line) => line.items));
      if (analysis.empty) continue;
      const padding = Math.round(12 * config.PDF_RENDER_SCALE / 2);
      const top = Math.max(0, analysis.top - padding); const bottom = Math.min(info.height, analysis.bottom + padding);
      const cropPath = path.join(directory, `${paperId}-p${String(page.pageNo).padStart(3, "0")}-q${region.questionNo.padStart(2, "0")}${region.continuesFromPreviousPage ? "-cont" : ""}.png`);
      await sharp(page.localPath).extract({ left: 0, top, width: info.width, height: bottom - top }).png().toFile(cropPath);
      const buffer = await fs.readFile(cropPath);
      const figures = analysis.figures.map((box) => ({ pagePath: page.localPath, box }));
      const question = parseTextQuestion(region);
      if (config.PDF_TEXT_MODE === "auto" && isTextOnlyEligible(region, analysis.residualInkRatio, question)) {
        logger.info("PDF_TEXT", { page: page.pageNo, q: region.questionNo, textOnly: true });
        items.push({ buffer, cropPath, textQuestion: question!, figures, method: "pdf_text", planned: true });
      } else {
        items.push({ buffer, cropPath, textHint: this.regionHint(region), figures, method: "vision+pdf_text", planned: true });
      }
    }
    return items;
  }

  private regionHint(region: QuestionRegion): string {
    const note = region.continuesFromPreviousPage
      ? `（本图片区域是第 ${region.questionNo} 题跨页后的续接部分：number 填 "${region.questionNo}"，continues_from_previous_page=true。）\n`
      : "";
    return `${note}${regionText(region)}`;
  }

  private parseYear(title: string): number | null { const match = title.match(/(?:19|20)\d{2}/); return match ? Number(match[0]) : null; }

  private printDryRun(options: CrawlOptions): void {
    console.log("========== Dry Run ==========");
    console.log(`页面计划：${options.paper ? `正常详情 paperId=${options.paper}` : options.keyword ? `正常搜索 keyword=${options.keyword}` : "正常试卷列表"}`);
    console.log(`预计列表请求：${options.paper ? 0 : 1}`); console.log(`预计每张试卷详情/预览：2 个核心请求（详情 + 预览）`);
    console.log(`试卷原件：${config.PREVIEW_SOURCE === "canvas" ? "不保存（PREVIEW_SOURCE=canvas）" : "被动保存预览页面已加载的原始 PDF，不发额外请求"}`);
    console.log(`PDF 文字层：${config.PDF_TEXT_MODE === "off" ? "不使用" : config.PDF_TEXT_MODE === "hint" ? "作为 AI 转录参考" : "纯文字题直接解析，其余作为 AI 转录参考"}`);
    console.log("AI：仅对无法由 PDF 文字层忠实还原、且未命中 vision_cache 的 crop 调用；受运行预算限制");
    console.log("资料下载：否"); console.log("资料下载额度消耗：0");
  }

  private printSummary(summary: Record<string, number>, network: { requests: number }, vision: {
    requests: number; cacheHits: number; verifications: number; formulaReviews?: number;
  }, status: string): void {
    console.log("========== Crawl Summary =========="); console.log(`网络请求：${network.requests ?? 0}`);
    console.log(`发现试卷：${summary.scannedPapers}  新增试卷：${summary.newPapers}`);
    console.log(`发现题目：${summary.scannedQuestions}  新增题目：${summary.newQuestions}  重复题目：${summary.duplicates}`);
    console.log(`原始 PDF：${summary.pdfPapers}  PDF 文字层直出题目（未调用 AI）：${summary.textOnlyQuestions}`);
    console.log(`AI 请求：${vision.requests}  缓存命中：${vision.cacheHits}  二次验证：${vision.verifications}  公式局部复核：${vision.formulaReviews ?? 0}`);
    console.log("资料下载额度消耗：0"); console.log(`STATUS: ${status}`);
  }
}
