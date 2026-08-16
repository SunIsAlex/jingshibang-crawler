import { describe, expect, it } from "vitest";
import { assertChoiceOptionsComplete, assertCompleteNumericSequence, continuationTextSimilarity, looksLikeAnswerMaterial } from "../src/crawler/crawler.js";
import { mergePendingQuestions, type ScoredQuestion } from "../src/vision/extractor.js";
import type { ExtractedQuestion } from "../src/parsing/schemas.js";

function question(number: string, stem: string, flags: { from?: boolean; next?: boolean } = {}): ExtractedQuestion {
  return {
    number,
    type: "short_answer",
    stem_markdown: stem,
    options: [],
    images: [],
    confidence: 0.95,
    uncertain_regions: [],
    continues_from_previous_page: flags.from ?? false,
    continues_on_next_page: flags.next ?? false,
  };
}

const scored = (value: ExtractedQuestion): ScoredQuestion => ({ question: value, finalConfidence: 0.95, formulaIssues: [] });

describe("answer boundary and cross-page safety", () => {
  it("recognizes a reference-answer page by majority markers", () => {
    expect(looksLikeAnswerMaterial([
      scored(question("1", "【详解】由条件可得……")),
      scored(question("2", "【分析】先考察定义域……")),
      scored(question("3", "普通题干")),
    ])).toBe(true);
  });

  it("does not classify ordinary question pages as answers", () => {
    expect(looksLikeAnswerMaterial([
      scored(question("1", "已知函数 $f(x)$，求其定义域。")),
      scored(question("2", "如图，证明两直线平行。")),
    ])).toBe(false);
  });

  it("never merges a newly numbered question only because the previous item says continued", () => {
    const merged = mergePendingQuestions([
      question("17", "第 17 题", { next: true }),
      question("18", "第 18 题", { from: true }),
    ]);
    expect(merged.map((item) => item.number)).toEqual(["17", "18"]);
  });

  it("merges the same numbered question across pages", () => {
    const merged = mergePendingQuestions([
      question("15", "上半部分", { next: true }),
      question("15", "下半部分", { from: true }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.stem_markdown).toContain("下半部分");
  });

  it("rejects missing or duplicate numeric questions before persistence", () => {
    const wrap = (number: string) => ({ scored: { question: { number } } });
    expect(() => assertCompleteNumericSequence([wrap("1"), wrap("2"), wrap("4")])).toThrow(/missing=\[3\]/);
    expect(() => assertCompleteNumericSequence([wrap("1"), wrap("2"), wrap("2")])).toThrow(/duplicates=\[2\]/);
    expect(() => assertCompleteNumericSequence([wrap("1"), wrap("2"), wrap("3")])).not.toThrow();
  });

  it("recognizes a semantically repeated cross-page stem without trusting its wrong number", () => {
    const previous = "如图，在三棱柱 ABC-A_1B_1C_1 中，三角形 ABC 为正三角形，D 是 AB 的中点";
    const continuation = "如图所示，三棱柱 ABC-A_1B_1C_1 中，点 D 为棱 AB 的中点";
    expect(continuationTextSimilarity(previous, continuation)).toBeGreaterThanOrEqual(0.2);
    expect(continuationTextSimilarity(previous, "在三角形中求角 B")).toBeLessThan(0.2);
  });

  it("rejects incomplete choice options before persistence", () => {
    const value = question("3", "题干"); value.type = "single_choice";
    expect(() => assertChoiceOptionsComplete([{ scored: { question: value } }])).toThrow(/\[3\]/);
    value.options = [{ label: "A", markdown: "1" }, { label: "B", markdown: "2" }];
    expect(() => assertChoiceOptionsComplete([{ scored: { question: value } }])).not.toThrow();
  });
});
