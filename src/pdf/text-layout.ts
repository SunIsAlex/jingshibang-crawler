import type { ExtractedOption, ExtractedQuestion } from "../parsing/schemas.js";

/** Text item in rendered-page pixel coordinates (origin top-left). */
export interface PdfTextItem {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  fontSize: number;
}

export interface PdfTextLine extends Omit<PdfTextItem, "text"> {
  text: string;
  items: PdfTextItem[];
}

export interface PdfPageText {
  pageNo: number;
  width: number;
  height: number;
  lines: PdfTextLine[];
  /** True when the embedded text layer exists and is not garbled. */
  reliable: boolean;
}

export type SectionType = ExtractedQuestion["type"];

export interface QuestionRegion {
  pageNo: number;
  top: number;
  bottom: number;
  /** Always set; continuation regions carry the number of the question they continue. */
  questionNo: string;
  continuesFromPreviousPage: boolean;
  continuesOnNextPage: boolean;
  section: SectionType | null;
  lines: PdfTextLine[];
}

export interface RegionPlan {
  regions: QuestionRegion[];
  /** Pages whose question regions come from the text layer. Other pages need image segmentation. */
  plannedPages: Set<number>;
  answerBoundary: { pageNo: number; top: number; reason: string } | null;
}

// Some PDF producers map simplified characters to "CJK Radicals Supplement" code points, which NFKC leaves alone.
const radicalSupplement: Record<string, string> = {
  "⺟": "母", "⺠": "民", "⻄": "西", "⻅": "见", "⻆": "角", "⻈": "讠", "⻉": "贝",
  "⻋": "车", "⻐": "钅", "⻑": "長", "⻓": "长", "⻔": "门", "⻗": "雨", "⻘": "青",
  "⻙": "韦", "⻚": "页", "⻛": "风", "⻜": "飞", "⻝": "食", "⻠": "饣", "⻢": "马",
  "⻣": "骨", "⻤": "鬼", "⻥": "鱼", "⻦": "鸟", "⻧": "卤", "⻨": "麦", "⻩": "黄",
  "⻪": "黾", "⻬": "齐", "⻮": "齿", "⻰": "龙", "⻳": "龟",
};

/** Repair PDF ToUnicode artifacts without NFKC-folding ordinary full-width Chinese punctuation. */
export function repairPdfText(input: string): string {
  let output = "";
  for (const char of input) {
    const code = char.codePointAt(0)!;
    if (radicalSupplement[char]) output += radicalSupplement[char];
    // Kangxi radicals, CJK compatibility ideographs and math alphanumerics have exact NFKC equivalents.
    else if ((code >= 0x2F00 && code <= 0x2FDF) || (code >= 0xF900 && code <= 0xFAFF) || (code >= 0x1D400 && code <= 0x1D7FF)) {
      output += char.normalize("NFKC");
    } else output += char;
  }
  return output;
}

export function textQuality(text: string): { characters: number; garbled: number; reliable: boolean } {
  let characters = 0; let garbled = 0;
  for (const char of text) {
    if (/\s/u.test(char)) continue;
    characters += 1;
    const code = char.codePointAt(0)!;
    if (code === 0xFFFD || (code >= 0xE000 && code <= 0xF8FF) || code >= 0xF0000 || code < 0x20) garbled += 1;
  }
  return { characters, garbled, reliable: characters >= 20 && garbled / Math.max(1, characters) < 0.02 };
}

export function groupTextLines(items: PdfTextItem[]): PdfTextLine[] {
  const sorted = items.filter((item) => item.text.length > 0 && item.right >= item.left)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: PdfTextLine[] = [];
  for (const item of sorted) {
    const height = item.bottom - item.top;
    // Only compare with recent lines; text is sorted top-down.
    const line = lines.slice(-4).find((candidate) => {
      const overlap = Math.min(candidate.bottom, item.bottom) - Math.max(candidate.top, item.top);
      return overlap >= 0.5 * Math.min(height, candidate.bottom - candidate.top);
    });
    if (line) {
      line.items.push(item);
      line.top = Math.min(line.top, item.top); line.bottom = Math.max(line.bottom, item.bottom);
      line.left = Math.min(line.left, item.left); line.right = Math.max(line.right, item.right);
      line.fontSize = Math.max(line.fontSize, item.fontSize);
    } else {
      lines.push({ text: "", items: [item], left: item.left, top: item.top, right: item.right, bottom: item.bottom, fontSize: item.fontSize });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.left - b.left);
    let text = ""; let previous: PdfTextItem | undefined;
    for (const item of line.items) {
      if (previous && item.left - previous.right > 0.3 * Math.max(item.fontSize, previous.fontSize) && !/\s$/.test(text)) text += " ";
      text += item.text; previous = item;
    }
    line.text = text.replace(/\s+/g, " ").trim();
  }
  return lines.filter((line) => line.text.length > 0).sort((a, b) => a.top - b.top);
}

const questionStart = /^\s*(\d{1,3})\s*[.．、](?!\d)\s*/u;
const sectionHeading = /^\s*[一二三四五六七八九十]{1,3}\s*[、.．]/u;
const pageFurniture = /第\s*\d+\s*页|共\s*\d+\s*页|^\s*[-—]?\s*\d{1,3}\s*[-—]?\s*$/u;
const answerHeading = /^(?:参考答案|答案|答案(?:与|及)(?:解析|详解|评分标准)|参考答案(?:与|及)(?:解析|评分标准)|试题解析|评分标准)$/u;
const inlineAnswer = /^\s*(?:【\s*(?:答案|解析|详解|分析|点睛|解答|考点|评析|点评)\s*】|(?:答案|解析|详解)\s*[:：])/u;

export function isAnswerHeading(text: string): boolean {
  return answerHeading.test(text.replace(/[\s:：【】\[\]()（）]/gu, ""));
}

export function sectionTypeFromHeading(text: string): SectionType | null {
  if (/多选|多项选择|不定项/u.test(text)) return "multiple_choice";
  if (/选择题/u.test(text)) return "single_choice";
  if (/填空题/u.test(text)) return "fill_blank";
  if (/判断题/u.test(text)) return "true_false";
  if (/证明题/u.test(text)) return "proof";
  if (/解答题|计算题|简答题|论述题|材料|综合题|探究题|应用题/u.test(text)) return "short_answer";
  return null;
}

/**
 * Split text-layer pages into one region per question. Question starts must follow a strict 1,2,3... sequence,
 * so sub-items, years or option text are never mistaken for questions. Everything after an answer heading,
 * a numbering restart, or an inline 【答案】/【解析】 block is excluded so answers never reach the vision model.
 */
export function planQuestionRegions(pages: PdfPageText[]): RegionPlan {
  const plan: RegionPlan = { regions: [], plannedPages: new Set(), answerBoundary: null };
  let lastNo = 0; let section: SectionType | null = null;
  let open = null as QuestionRegion | null; // question still open at the end of the previous page

  for (const page of pages) {
    if (!page.reliable) { open = null; continue; }
    plan.plannedPages.add(page.pageNo);
    const content = page.lines.filter((line) => !(pageFurniture.test(line.text)
      && (line.top < page.height * 0.08 || line.bottom > page.height * 0.92)));
    const contentTop = Math.max(0, Math.min(page.height, ...content.map((line) => line.top)) - 4);
    const footer = page.lines.filter((line) => line.top >= page.height * 0.92 && !content.includes(line));
    const pageBottom = footer.length ? Math.min(...footer.map((line) => line.top)) : page.height;
    let current: QuestionRegion | null = null; let skipping = false;
    let continuedFrom = open as QuestionRegion | null;
    const close = (bottom: number, reachedPageEnd = false): void => {
      const region = current; current = null; open = null;
      if (!region) return;
      region.bottom = Math.max(region.top + 1, bottom);
      // A continuation without text is kept only if it is tall enough to hold a figure; the crawler drops blank crops.
      const keep = region.lines.length > 0 || (region.continuesFromPreviousPage && region.bottom - region.top >= page.height * 0.03);
      if (keep) plan.regions.push(region);
      if (region.continuesFromPreviousPage && continuedFrom) continuedFrom.continuesOnNextPage = keep;
      if (keep && reachedPageEnd) open = region;
    };
    if (continuedFrom) {
      current = { pageNo: page.pageNo, top: contentTop, bottom: pageBottom, questionNo: continuedFrom.questionNo,
        continuesFromPreviousPage: true, continuesOnNextPage: false, section: continuedFrom.section, lines: [] };
    }
    for (const line of content) {
      const number = line.text.match(questionStart)?.[1];
      const heading = isAnswerHeading(line.text);
      if (heading || (number === "1" && lastNo >= 2)) {
        close(line.top);
        plan.answerBoundary = { pageNo: page.pageNo, top: line.top, reason: heading ? "answer-heading" : "numbering-restart" };
        return plan;
      }
      if (inlineAnswer.test(line.text)) { close(line.top); skipping = true; continue; }
      if (sectionHeading.test(line.text)) {
        close(line.top); skipping = false; section = sectionTypeFromHeading(line.text) ?? section; continue;
      }
      if (number && Number(number) === lastNo + 1) {
        close(line.top); skipping = false; lastNo += 1; continuedFrom = null;
        current = { pageNo: page.pageNo, top: line.top, bottom: pageBottom, questionNo: number,
          continuesFromPreviousPage: false, continuesOnNextPage: false, section, lines: [line] };
        continue;
      }
      if (current && !skipping) (current as QuestionRegion).lines.push(line);
    }
    close(pageBottom, true);
  }
  return plan;
}

export function regionText(region: Pick<QuestionRegion, "lines">): string {
  return region.lines.map((line) => line.text).join("\n");
}

export function linesInBand(lines: PdfTextLine[], top: number, bottom: number): PdfTextLine[] {
  return lines.filter((line) => line.bottom > top && line.top < bottom);
}

function splitOptions(text: string, anyStart: boolean): { stem: string; options: ExtractedOption[] } {
  const markers = [...text.matchAll(/(?:^|[\s\n])([A-H])\s*[.．、]\s*/gu)]
    .map((match) => ({ label: match[1]!, index: match.index!, end: match.index! + match[0].length }));
  let best: typeof markers = [];
  for (let start = 0; start < markers.length; start += 1) {
    if (!anyStart && markers[start]!.label !== "A") continue;
    const chain = [markers[start]!];
    for (const marker of markers.slice(start + 1)) {
      if (marker.label.charCodeAt(0) === chain.at(-1)!.label.charCodeAt(0) + 1) chain.push(marker);
    }
    if (chain.length > best.length) best = chain;
  }
  if (best.length < (anyStart ? 1 : 2)) return { stem: text.trim(), options: [] };
  const options = best.map((marker, index) => ({
    label: marker.label,
    markdown: text.slice(marker.end, best[index + 1]?.index ?? text.length).replace(/\s+/g, " ").trim(),
  }));
  return { stem: text.slice(0, best[0]!.index).trim(), options };
}

/** Build a question straight from PDF text. Returns null when the text does not look like a complete question. */
export function parseTextQuestion(region: QuestionRegion): ExtractedQuestion | null {
  let text = regionText(region);
  if (!region.continuesFromPreviousPage) text = text.replace(questionStart, "");
  const { stem, options } = splitOptions(text, region.continuesFromPreviousPage);
  const choice = region.section === "single_choice" || region.section === "multiple_choice";
  if (choice && options.length < 2 && !region.continuesFromPreviousPage && !region.continuesOnNextPage) return null;
  if (!stem && options.length === 0) return null;
  const type: SectionType = options.length >= 2
    ? (region.section === "multiple_choice" || /多选|多项|不定项/u.test(stem) ? "multiple_choice" : "single_choice")
    : region.section ?? (/_{3,}|＿{2,}/u.test(stem) ? "fill_blank" : "short_answer");
  return {
    number: region.questionNo,
    type,
    stem_markdown: stem || "（续）",
    options,
    images: [],
    confidence: 0.97,
    uncertain_regions: [],
    continues_from_previous_page: region.continuesFromPreviousPage,
    continues_on_next_page: region.continuesOnNextPage,
  };
}

const mathLike = /[A-Za-z=+−<>≤≥≠≈±×÷·∶∵∴√∑∏∫∞∈∉⊂⊃⊆⊇∪∩∠⊥∥△▱⊙πθαβγδλμσφωΔΩ′″^/|{}\\]/u;

/**
 * A region may skip vision entirely only when the PDF text alone is a faithful transcription:
 * no Latin letters or math symbols (those must become LaTeX), no sub/superscripts, and no graphics.
 */
export function isTextOnlyEligible(region: QuestionRegion, residualInkRatio: number, question: ExtractedQuestion | null): boolean {
  if (!question || region.lines.length === 0) return false;
  const content = [question.stem_markdown, ...question.options.map((option) => option.markdown)].join("\n");
  if (mathLike.test(content)) return false;
  const sizes = region.lines.flatMap((line) => line.items).filter((item) => item.text.trim()).map((item) => item.fontSize).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
  if (sizes.some((size) => size < median * 0.8)) return false;
  return residualInkRatio < 0.0008;
}
