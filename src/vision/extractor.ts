import { config } from "../config.js";
import { FormulaValidator } from "../parsing/formula-validator.js";
import type { ExtractedQuestion } from "../parsing/schemas.js";
import { sha256 } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import { VisionBudgetGuard } from "../crawler/quota.js";
import { VisionCache } from "./cache.js";
import type { VisionProvider } from "./provider.js";
import type { VisionExtractOptions } from "./provider.js";

export interface ScoredQuestion {
  question: ExtractedQuestion;
  finalConfidence: number;
  formulaIssues: string[];
}

export class VisionExtractor {
  private readonly formulaValidator = new FormulaValidator();

  constructor(
    private readonly provider: VisionProvider,
    private readonly cache: VisionCache,
    private readonly budget: VisionBudgetGuard,
  ) {}

  async extract(images: Buffer[], paperId: string, page: number): Promise<ScoredQuestion[]> {
    const imageHash = sha256(Buffer.concat(images));
    let questions = this.cache.get(imageHash, this.provider.model, config.VISION_PROMPT_VERSION);
    if (questions) {
      this.budget.recordCacheHit();
      logger.info("VISION", { page, cache: "hit" });
    } else {
      questions = await this.requestWithSchemaRetry(images, { paperId, page, promptVersion: config.VISION_PROMPT_VERSION });
      this.cache.put(imageHash, this.provider.model, config.VISION_PROMPT_VERSION, questions);
      logger.info("VISION", { page, cache: "miss", questions: questions.length });
    }
    return questions.map((question) => this.score(question));
  }

  async verifyLowConfidence(images: Buffer[], paperId: string, page: number, first: ScoredQuestion[]): Promise<ScoredQuestion[]> {
    if (first.every((item) => item.finalConfidence >= 0.95)) return first;
    const imageHash = sha256(Buffer.concat(images));
    const firstHash = sha256(JSON.stringify(first.map((item) => item.question))).slice(0, 16);
    const cacheVersion = `${config.VISION_PROMPT_VERSION}:verify:${firstHash}`;
    let verified = this.cache.get(imageHash, this.provider.model, cacheVersion);
    if (verified) {
      this.budget.recordCacheHit();
      return verified.map((question) => this.score(question));
    }
    try {
      verified = await this.requestWithSchemaRetry(images, {
        paperId, page, promptVersion: config.VISION_PROMPT_VERSION, mode: "verify",
        firstResult: first.map((item) => item.question),
      });
      if (verified.length !== first.length) throw new Error("Verification changed the question count");
    } catch {
      logger.warn("VISION", { page, verify: "failed", action: "retain-first-result-needs-review" });
      return first.map((item) => ({
        ...item,
        question: {
          ...structuredClone(item.question),
          uncertain_regions: [...item.question.uncertain_regions, "secondary verification failed"],
        },
        finalConfidence: Math.min(item.finalConfidence, 0.79),
      }));
    }
    this.budget.usage.verifications += 1;
    this.cache.put(imageHash, this.provider.model, cacheVersion, verified);
    return verified.map((question) => this.score(question));
  }

  async verifyFormula(image: Buffer, paperId: string, page: number): Promise<ExtractedQuestion> {
    const imageHash = sha256(image);
    const cacheVersion = `${config.VISION_PROMPT_VERSION}:formula`;
    let result = this.cache.get(imageHash, this.provider.model, cacheVersion);
    if (result) this.budget.recordCacheHit();
    else {
      result = await this.requestWithSchemaRetry([image], {
        paperId, page, promptVersion: config.VISION_PROMPT_VERSION, mode: "formula",
      });
      this.cache.put(imageHash, this.provider.model, cacheVersion, result);
    }
    this.budget.usage.formulaReviews += 1;
    return result[0] ?? {
      number: "formula", type: "unknown", stem_markdown: "[UNCERTAIN: formula]", options: [], images: [],
      confidence: 0, uncertain_regions: ["empty formula verification"],
      continues_from_previous_page: false, continues_on_next_page: false,
    };
  }

  private async requestWithSchemaRetry(images: Buffer[], options: VisionExtractOptions): Promise<ExtractedQuestion[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.budget.assertCanRequest(images.length);
      this.budget.recordRequest(images.length);
      try {
        return await this.provider.extractQuestion(images, options);
      } catch (error) {
        lastError = error;
        this.budget.usage.failed += 1;
        logger.warn("VISION", { page: options.page, mode: options.mode ?? "extract", attempt: attempt + 1, failed: true });
      }
    }
    throw lastError;
  }

  private score(question: ExtractedQuestion): ScoredQuestion {
    const combined = [question.stem_markdown, ...question.options.map((option) => option.markdown)].join("\n");
    const formula = this.formulaValidator.validate(combined);
    let confidence = question.confidence - formula.confidencePenalty;
    confidence -= Math.min(0.3, question.uncertain_regions.length * 0.05);
    if (["single_choice", "multiple_choice"].includes(question.type) && question.options.length < 2) confidence -= 0.2;
    if (/\[UNCERTAIN:/i.test(combined)) confidence -= 0.1;
    return {
      question,
      finalConfidence: Math.max(0, Math.min(1, confidence)),
      formulaIssues: formula.issues.map((issue) => issue.code),
    };
  }
}

export function mergePendingQuestions(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  const output: ExtractedQuestion[] = [];
  for (const current of questions) {
    const previous = output.at(-1);
    const sameNumber = previous?.number === current.number;
    const continuationNumber = /^(?:continuation|continued|unknown|续|接上页|\?)$/i.test(current.number.trim());
    const shouldMerge = Boolean(previous && (
      (sameNumber && (current.continues_from_previous_page || previous.continues_on_next_page))
      || (current.continues_from_previous_page && continuationNumber)
    ));
    if (shouldMerge && previous) {
      previous.stem_markdown = `${previous.stem_markdown}\n${current.stem_markdown}`.trim();
      previous.options = [...previous.options, ...current.options];
      previous.images = [...previous.images, ...current.images];
      previous.confidence = Math.min(previous.confidence, current.confidence);
      previous.uncertain_regions = [...previous.uncertain_regions, ...current.uncertain_regions];
      previous.continues_on_next_page = current.continues_on_next_page;
    } else output.push(structuredClone(current));
  }
  return output;
}
