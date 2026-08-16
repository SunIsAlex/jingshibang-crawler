import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleVisionProvider } from "../src/vision/openai.js";

const result = {
  paper_id: "paper-probe",
  page: 1,
  questions: [{
    number: "1",
    type: "fill_blank",
    stem_markdown: "测试题",
    options: [],
    images: [],
    confidence: 0.99,
    uncertain_regions: [],
    continues_from_previous_page: false,
    continues_on_next_page: false,
  }],
};

function apiResponse(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function invoke(model: string): Promise<ReturnType<typeof vi.fn>> {
  const fetchMock = vi.fn().mockResolvedValue(apiResponse({ content: JSON.stringify(result) }));
  vi.stubGlobal("fetch", fetchMock);
  await new OpenAICompatibleVisionProvider(model).extractQuestion([Buffer.from("image")], {
    paperId: "paper-probe",
    page: 1,
    promptVersion: "test",
  });
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("Qwen thinking controls", () => {
  it("omits unsupported enable_thinking for Qwen VL Instruct", async () => {
    const fetchMock = await invoke("Qwen/Qwen3-VL-32B-Instruct");
    const payload = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("enable_thinking");
  });

  it("explicitly disables thinking for configurable Qwen models", async () => {
    const fetchMock = await invoke("Qwen/Qwen3-VL-30B-A3B");
    const payload = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(payload.enable_thinking).toBe(false);
  });

  it("rejects reasoning content even when structured content is valid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse({
      content: JSON.stringify(result),
      reasoning_content: "hidden reasoning",
    })));
    await expect(new OpenAICompatibleVisionProvider("Qwen/Qwen3-VL-32B-Instruct").extractQuestion(
      [Buffer.from("image")],
      { paperId: "paper-probe", page: 1, promptVersion: "test" },
    )).rejects.toThrow(/reasoning content/i);
  });

  it("strictly validates and wraps a single-question verification response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse({ content: JSON.stringify(result.questions[0]) })));
    const questions = await new OpenAICompatibleVisionProvider("Qwen/Qwen3-VL-32B-Instruct").extractQuestion(
      [Buffer.from("image")],
      { paperId: "paper-probe", page: 1, promptVersion: "test", mode: "verify", firstResult: [] },
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]?.number).toBe("1");
  });

  it("strictly parses normalized figure locations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse({ content: JSON.stringify({
      figures: [{ image_index: 1, bbox_1000: [100, 200, 700, 800], confidence: 0.96, kind: "geometry" }],
    }) })));
    const locations = await new OpenAICompatibleVisionProvider("Qwen/Qwen3-VL-32B-Instruct").locateFigures(
      [Buffer.from("page-1"), Buffer.from("page-2")],
      { paperId: "paper-probe", questionNo: "8", stemMarkdown: "如图……", promptVersion: "test" },
    );
    expect(locations).toEqual([{ imageIndex: 1, bbox1000: [100, 200, 700, 800], confidence: 0.96, kind: "geometry" }]);
  });
});
