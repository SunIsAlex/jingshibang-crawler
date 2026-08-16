import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { createBrowserSession } from "../browser/session.js";
import { NetworkObserver } from "../browser/network-observer.js";
import { AppDatabase } from "../database/database.js";
import { Repository } from "../database/repository.js";
import { JingshibangClient, type SearchOptions } from "../jingshibang/client.js";
import { routes } from "../jingshibang/routes.js";
import { RequestSafetyGuard } from "../jingshibang/security.js";
import type { ExtractedQuestion, PaperListItem } from "../parsing/schemas.js";
import { atomicWrite, ensureDir, pathExists } from "../utils/files.js";
import { sha256 } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import { normalizeQuestionText } from "../utils/normalize.js";
import { VisionCache } from "../vision/cache.js";
import { VisionExtractor, type ScoredQuestion } from "../vision/extractor.js";
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
interface PendingSave { scored: ScoredQuestion; sourcePages: number[]; cropPath: string; formulaReview: FormulaReviewResult | undefined }

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
      newQuestions: 0, duplicates: 0, updated: 0, pageCacheHits: 0 };
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
          pdf: Boolean(detail.pdf_paper), answer: Boolean(detail.pdf_answer), pages: opened.pages.map((page) => page.sha256) }));
        const paperRecord = repository.upsertPaper({ remoteId: paper.id, title: detail.store_name, year: this.parseYear(detail.store_name),
          region: detail.district || null, grade: detail.store_grade || null, subject: detail.store_subject || null,
          examType: detail.store_type || null, sourceUrl: routes.paperDetail(paper.id, detail.store_name), contentHash });
        if (paperRecord.created) summary.newPapers += 1;
        else summary.existingPapers += 1;
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
        for (const page of opened.pages) {
          if (interrupted) break;
          const crops = await segmenter.segment(page.localPath, paper.id, page.pageNo);
          const pageExtractions: Array<{ scored: ScoredQuestion[]; buffer: Buffer; cropPath: string }> = [];
          let answerPageDetected = false;
          for (const crop of crops) {
            const buffer = await fs.readFile(crop.path);
            const scored = await vision.extract([buffer], paper.id, page.pageNo);
            pageExtractions.push({ scored, buffer, cropPath: crop.path });
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
            try {
              scored = await vision.verifyLowConfidence([extraction.buffer], paper.id, page.pageNo, extraction.scored);
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
              this.appendPending(pending, item, page.pageNo, extraction.cropPath, formulaReview);
            }
          }
          checkpoint.save("crawl", {
            ...(options.keyword ? { keyword: options.keyword } : {}), page: options.page ?? 1, paperId: paper.id, previewPage: page.pageNo,
          });
        }
        if (interrupted) break;
        if (pending.length === 0) throw new Error(`No question pages were identified for paper ${paper.id}`);
        assertCompleteNumericSequence(pending);
        assertChoiceOptionsComplete(pending);
        const prepared: Array<{ item: PendingSave; asset: { localPath: string; sha256: string } | null }> = [];
        for (const item of pending) prepared.push({ item, asset: await this.materializeQuestionAsset(item.scored.question, item.cropPath) });
        const savedResults = database.db.transaction(() => {
          if (!paperRecord.created) repository.replacePaperSources(paperRecord.id);
          return prepared.map(({ item, asset }) => {
            const saved = repository.saveQuestion(paperRecord.id, item.scored.question, item.sourcePages, item.cropPath,
              item.scored.finalConfidence, asset ? [asset.sha256] : []);
            if (asset) repository.saveAsset({ questionId: saved.id, localPath: asset.localPath, sha256: asset.sha256, mimeType: "image/png" });
            if (item.formulaReview) repository.saveFormulaReview({ questionId: saved.id, cropPath: item.formulaReview.cropPath,
              formulaMarkdown: item.formulaReview.formula, confidence: item.formulaReview.confidence, issues: item.formulaReview.issues });
            return { item, saved };
          });
        })();
        for (const { item, saved } of savedResults) {
          summary.scannedQuestions += 1;
          if (saved.duplicate) summary.duplicates += 1; else summary.newQuestions += 1;
          logger.info("QUESTION", { number: item.scored.question.number, duplicate: saved.duplicate, hash: saved.contentHash.slice(0, 12) });
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

  private appendPending(pending: PendingSave[], scored: ScoredQuestion, page: number, cropPath: string,
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
    } else pending.push({ scored: { ...scored, question: structuredClone(question) }, sourcePages: [page], cropPath, formulaReview });
  }

  private async repairIncompleteCrossPageChoice(
    pending: PendingSave[],
    pageExtractions: Array<{ scored: ScoredQuestion[]; buffer: Buffer; cropPath: string }>,
    vision: VisionExtractor,
    paperId: string,
    page: number,
  ): Promise<void> {
    const previous = pending.at(-1); const first = pageExtractions[0];
    if (!previous || !first || previous.sourcePages.at(-1) === page) return;
    const question = previous.scored.question;
    if (!["single_choice", "multiple_choice"].includes(question.type)) return;
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
    extractions: Array<{ scored: ScoredQuestion[]; buffer: Buffer; cropPath: string }>,
    vision: VisionExtractor,
    paperId: string,
    page: number,
  ): Promise<void> {
    for (let index = 0; index < extractions.length - 1; index += 1) {
      const current = extractions[index]!; const next = extractions[index + 1]!;
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

  private async materializeQuestionAsset(question: ExtractedQuestion, cropPath: string): Promise<{ localPath: string; sha256: string } | null> {
    if (question.images.length === 0) return null;
    const buffer = await fs.readFile(cropPath); const imageHash = sha256(buffer);
    await ensureDir(config.assetsDir);
    const localPath = path.join(config.assetsDir, `${imageHash}.png`);
    if (!await pathExists(localPath)) await fs.copyFile(cropPath, localPath);
    for (const image of question.images) image.path = localPath;
    return { localPath, sha256: imageHash };
  }

  private parseYear(title: string): number | null { const match = title.match(/(?:19|20)\d{2}/); return match ? Number(match[0]) : null; }

  private printDryRun(options: CrawlOptions): void {
    console.log("========== Dry Run ==========");
    console.log(`页面计划：${options.paper ? `正常详情 paperId=${options.paper}` : options.keyword ? `正常搜索 keyword=${options.keyword}` : "正常试卷列表"}`);
    console.log(`预计列表请求：${options.paper ? 0 : 1}`); console.log(`预计每张试卷详情/预览：2 个核心请求（详情 + 预览）`);
    console.log("AI：仅对未命中 vision_cache 的 crop 调用；受运行预算限制");
    console.log("资料下载：否"); console.log("资料下载额度消耗：0");
  }

  private printSummary(summary: Record<string, number>, network: { requests: number }, vision: {
    requests: number; cacheHits: number; verifications: number; formulaReviews?: number;
  }, status: string): void {
    console.log("========== Crawl Summary =========="); console.log(`网络请求：${network.requests ?? 0}`);
    console.log(`发现试卷：${summary.scannedPapers}  新增试卷：${summary.newPapers}`);
    console.log(`发现题目：${summary.scannedQuestions}  新增题目：${summary.newQuestions}  重复题目：${summary.duplicates}`);
    console.log(`AI 请求：${vision.requests}  缓存命中：${vision.cacheHits}  二次验证：${vision.verifications}  公式局部复核：${vision.formulaReviews ?? 0}`);
    console.log("资料下载额度消耗：0"); console.log(`STATUS: ${status}`);
  }
}
