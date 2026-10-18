import { describe, expect, it } from "vitest";
import {
  groupTextLines, isTextOnlyEligible, parseTextQuestion, planQuestionRegions, repairPdfText, textQuality,
  type PdfPageText, type PdfTextLine,
} from "../src/pdf/text-layout.js";

const lineHeight = 40;
function page(pageNo: number, texts: string[], options: { fontSizes?: Record<number, number> } = {}): PdfPageText {
  const lines: PdfTextLine[] = texts.map((text, index) => {
    const top = 100 + index * lineHeight; const fontSize = options.fontSizes?.[index] ?? 27;
    const item = { text, left: 100, right: 100 + text.length * 27, top, bottom: top + 34, fontSize };
    return { ...item, items: [item] };
  });
  return { pageNo, width: 1500, height: 2100, lines, reliable: true };
}

describe("PDF text layer repair", () => {
  it("maps radical code points to ideographs without folding Chinese punctuation", () => {
    expect(repairPdfText("本试卷共 4 ⻚，⾼⼀（下）𝑓(𝑥)")).toBe("本试卷共 4 页，高一（下）f(x)");
  });

  it("flags garbled text layers", () => {
    expect(textQuality("已知函数的定义域为全体实数，求函数的值域与单调区间。").reliable).toBe(true);
    expect(textQuality("已知函数的定义域为全体实数求函数的值").reliable).toBe(false);
  });

  it("groups items on one baseline into a single ordered line", () => {
    const lines = groupTextLines([
      { text: "B. 2", left: 400, right: 450, top: 100, bottom: 134, fontSize: 27 },
      { text: "A. 1", left: 100, right: 150, top: 101, bottom: 135, fontSize: 27 },
      { text: "2", left: 160, right: 170, top: 92, bottom: 112, fontSize: 16 },
      { text: "下一行", left: 100, right: 180, top: 150, bottom: 184, fontSize: 27 },
    ]);
    expect(lines.map((line) => line.text)).toEqual(["A. 1 2 B. 2", "下一行"]);
  });
});

describe("question region planning", () => {
  it("splits by strict question numbering, tracks sections, continuations and the answer heading", () => {
    const plan = planQuestionRegions([
      page(1, ["2026 期末试卷", "一、选择题共 2 小题", "1. 下列说法正确的是（ ）", "A. 甲 B. 乙 C. 丙 D. 丁",
        "2. 第二题题干", "A. 一 B. 二", "二、解答题", "3. 简述丝绸之路的影响。", "（1）列举两种物产；"]),
      page(2, ["（2）说明其历史意义。", "参考答案", "1. A 2. B"]),
    ]);
    expect(plan.regions.map((region) => [region.pageNo, region.questionNo, region.section, region.continuesFromPreviousPage]))
      .toEqual([[1, "1", "single_choice", false], [1, "2", "single_choice", false], [1, "3", "short_answer", false], [2, "3", "short_answer", true]]);
    expect(plan.regions[2]!.continuesOnNextPage).toBe(true);
    expect(plan.answerBoundary).toMatchObject({ pageNo: 2, reason: "answer-heading" });
    expect(plan.regions[3]!.bottom).toBeLessThanOrEqual(plan.answerBoundary!.top);
  });

  it("cuts interleaved 【答案】/【解析】 blocks out of question regions", () => {
    const plan = planQuestionRegions([page(1, ["1. 第一题题干内容", "【答案】B", "【解析】因为……", "2. 第二题题干内容"])]);
    expect(plan.regions.map((region) => region.lines.map((line) => line.text))).toEqual([["1. 第一题题干内容"], ["2. 第二题题干内容"]]);
    expect(plan.regions[0]!.bottom).toBe(140);
  });

  it("treats a numbering restart as the start of an answer key", () => {
    const plan = planQuestionRegions([page(1, ["1. 第一题题干内容很长", "2. 第二题题干内容很长", "1. C 2. D"])]);
    expect(plan.regions).toHaveLength(2);
    expect(plan.answerBoundary?.reason).toBe("numbering-restart");
  });

  it("does not plan pages whose text layer is unreliable", () => {
    const bad = { ...page(2, ["乱码"]), reliable: false };
    const plan = planQuestionRegions([page(1, ["1. 第一题题干内容很长很长"]), bad]);
    expect([...plan.plannedPages]).toEqual([1]);
    expect(plan.regions[0]!.continuesOnNextPage).toBe(false);
  });
});

describe("text-only question parsing", () => {
  const regionFor = (texts: string[], section: "single_choice" | "fill_blank" | null = "single_choice") =>
    ({ ...planQuestionRegions([page(1, texts)]).regions[0]!, section });

  it("parses stem and ordered options", () => {
    const question = parseTextQuestion(regionFor(["1. 下列关于古代科技的说法，正确的是（ ）", "A. 指南针 B. 造纸术", "C. 印刷术 D. 火药"]));
    expect(question).toMatchObject({ number: "1", type: "single_choice", stem_markdown: "下列关于古代科技的说法，正确的是（ ）" });
    expect(question!.options.map((option) => `${option.label}:${option.markdown}`)).toEqual(["A:指南针", "B:造纸术", "C:印刷术", "D:火药"]);
  });

  it("rejects a choice question whose options are not in the text layer", () => {
    expect(parseTextQuestion(regionFor(["1. 选出正确的一项（ ）"]))).toBeNull();
  });

  it("only skips vision for plain text without math, sub/superscripts or graphics", () => {
    const plain = regionFor(["1. 我国古代四大发明中，最早传入欧洲的是________。"], "fill_blank");
    expect(isTextOnlyEligible(plain, 0, parseTextQuestion(plain))).toBe(true);
    expect(isTextOnlyEligible(plain, 0.01, parseTextQuestion(plain))).toBe(false);
    const math = regionFor(["1. 已知函数 f(x)=x2+1，则 f(2) 的值为________。"], "fill_blank");
    expect(isTextOnlyEligible(math, 0, parseTextQuestion(math))).toBe(false);
    const base = plain.lines[0]!;
    const exponent = { text: "2", left: base.right, right: base.right + 14, top: base.top - 8, bottom: base.top + 12, fontSize: 14 };
    const superscript = { ...plain, lines: [{ ...base, items: [...base.items, exponent] }] };
    expect(isTextOnlyEligible(superscript, 0, parseTextQuestion(superscript))).toBe(false);
  });
});
