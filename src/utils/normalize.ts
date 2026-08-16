import type { ExtractedOption } from "../parsing/schemas.js";
import { sha256 } from "./hash.js";

const sourcePrefix = /^(?:来源|选自|摘自)[:：]?\s*[^\n]{0,80}(?:\n|$)/i;
const questionPrefix = /^\s*(?:第\s*)?\d+(?:\.\d+)?\s*(?:题|[.．、:：)])\s*/u;

function compactEquals(content: string): string {
  return content.replace(/[\t ]*=[\t ]*/g, "=");
}

/** Keep Typora-compatible operator spacing inside LaTeX delimiters only. */
export function normalizeLatexTranscript(input: string): string {
  return input
    .replace(/(\${1,2})([\s\S]*?)\1/g, (_match, delimiter: string, content: string) =>
      `${delimiter}${compactEquals(content)}${delimiter}`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, content: string) => `\\(${compactEquals(content)}\\)`)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, content: string) => `\\[${compactEquals(content)}\\]`);
}

export function stripMeaninglessHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

export function normalizeQuestionText(input: string): string {
  const normalized = stripMeaninglessHtml(input)
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(sourcePrefix, "")
    .replace(questionPrefix, "")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalizeLatexTranscript(normalized);
}

export interface HashableQuestion {
  stemMarkdown: string;
  options?: ExtractedOption[];
  imageHashes?: string[];
}

export function normalizedQuestionPayload(question: HashableQuestion): string {
  const stem = normalizeQuestionText(question.stemMarkdown);
  const options = (question.options ?? []).map((option) => ({
    label: option.label.normalize("NFKC").trim().toUpperCase(),
    markdown: normalizeQuestionText(option.markdown),
  }));
  const imageHashes = [...(question.imageHashes ?? [])].sort();
  return JSON.stringify({ stem, options, imageHashes });
}

export function questionContentHash(question: HashableQuestion): string {
  return sha256(normalizedQuestionPayload(question));
}
