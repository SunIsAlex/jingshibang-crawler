import { describe, expect, it } from "vitest";
import { normalizeLatexTranscript, normalizeQuestionText, normalizedQuestionPayload } from "../src/utils/normalize.js";

describe("normalizeQuestionText", () => {
  it("normalizes Unicode, whitespace, HTML and question number without damaging LaTeX", () => {
    expect(normalizeQuestionText(" １． <b>求</b>  $\\frac{a+b}{c+d}$\r\n ")).toBe("求 $\\frac{a+b}{c+d}$");
  });
  it("preserves option order in normalized payload", () => {
    const payload = normalizedQuestionPayload({ stemMarkdown: "题目", options: [
      { label: "B", markdown: "$2$" }, { label: "A", markdown: "$1$" },
    ] });
    expect(payload.indexOf('"B"')).toBeLessThan(payload.indexOf('"A"'));
  });
  it("removes spaces around equals inside LaTeX for Typora", () => {
    expect(normalizeQuestionText("填空：$\\omega = $，且 $f(x) = 1$")).toBe("填空:$\\omega=$,且 $f(x)=1$");
    expect(normalizeLatexTranscript("prose a = b; \\[x = y\\] and \\(z = 1\\)"))
      .toBe("prose a = b; \\[x=y\\] and \\(z=1\\)");
  });
});
