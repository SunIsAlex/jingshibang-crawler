import { describe, expect, it } from "vitest";
import { visionResultSchema } from "../src/parsing/schemas.js";

describe("vision schema", () => {
  const valid = { paper_id: "190065", page: 1, questions: [{ number: 1, type: "single_choice", stem_markdown: "已知 $f(x)=\\log_2x$", options: [{ label: "A", markdown: "$(0,+\\infty)$" }], images: [], confidence: 0.97, uncertain_regions: [], continues_from_previous_page: false, continues_on_next_page: false }] };
  it("accepts strict transcription JSON", () => expect(visionResultSchema.parse(valid).questions[0]?.number).toBe("1"));
  it("rejects solved-answer extras", () => expect(() => visionResultSchema.parse({ ...valid, questions: [{ ...valid.questions[0], correct_answer: "A" }] })).toThrow());
});
