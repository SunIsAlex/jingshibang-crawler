import { config, assertVisionConfigured } from "../config.js";
import { z } from "zod";
import { extractedQuestionSchema, visionResultSchema, type ExtractedQuestion } from "../parsing/schemas.js";
import { redactText } from "../utils/logger.js";
import type { FigureLocation, VisionExtractOptions, VisionProvider } from "./provider.js";
import { FORMULA_VERIFY_PROMPT, TRANSCRIPTION_PROMPT, VERIFY_PROMPT } from "./prompts.js";

interface ChatResponse {
  choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
  error?: { message?: string };
}

const figureLocationResponseSchema = z.object({
  figures: z.array(z.object({
    image_index: z.number().int().min(0).max(2),
    bbox_1000: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    confidence: z.number().min(0).max(1),
    kind: z.enum(["geometry", "chart", "table", "illustration", "other"]),
  }).strict()).max(4),
}).strict();

function chatCompletionsUrl(apiUrl: string): string {
  const trimmed = apiUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (trimmed.endsWith("/responses")) return trimmed.replace(/\/responses$/, "/chat/completions");
  return `${trimmed}/chat/completions`;
}

function parseJsonContent(content: string): unknown {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

function thinkingParameter(model: string): Record<string, boolean> {
  if (!config.VISION_DISABLE_THINKING || config.VISION_THINKING_PARAM_MODE === "never") return {};
  if (/-Thinking(?:-|$)/i.test(model)) {
    throw new Error(`Thinking-only model ${model} is not allowed for strict transcription; choose an Instruct model`);
  }
  if (config.VISION_THINKING_PARAM_MODE === "always") return { enable_thinking: false };
  // SiliconFlow rejects enable_thinking for Qwen3-VL *-Instruct. Those models are already non-thinking.
  if (/Qwen/i.test(model) && !/-Instruct(?:-|$)/i.test(model)) return { enable_thinking: false };
  return {};
}

export class OpenAICompatibleVisionProvider implements VisionProvider {
  readonly model: string;
  private readonly endpoint: string;

  constructor(model = config.VISION_MODEL) {
    this.model = model;
    this.endpoint = chatCompletionsUrl(config.API_URL);
  }

  async extractQuestion(images: Buffer[], options: VisionExtractOptions): Promise<ExtractedQuestion[]> {
    assertVisionConfigured();
    if (images.length < 1 || images.length > 3) throw new Error("Each vision request must contain 1 to 3 images");
    const basePrompt = options.mode === "verify" ? VERIFY_PROMPT : options.mode === "formula" ? FORMULA_VERIFY_PROMPT : TRANSCRIPTION_PROMPT;
    const context = options.mode === "verify" ? `\n首轮结果：${JSON.stringify(options.firstResult ?? [])}` : "";
    const content: Array<Record<string, unknown>> = [
      { type: "text", text: `${basePrompt}${context}\npaper_id=${options.paperId}; page=${options.page}; prompt_version=${options.promptVersion}` },
      ...images.map((image, index) => ({
        type: "image_url",
        image_url: { url: `data:${options.mimeTypes?.[index] ?? "image/png"};base64,${image.toString("base64")}` },
      })),
    ];
    const messageContent = await this.complete(content, 8_192);
    if (options.mode === "formula") {
      const formula = parseJsonContent(messageContent) as { formula?: string; confidence?: number; uncertain_regions?: string[] };
      return [{
        number: "formula",
        type: "unknown",
        stem_markdown: formula.formula ?? "[UNCERTAIN: formula]",
        options: [], images: [], confidence: formula.confidence ?? 0,
        uncertain_regions: formula.uncertain_regions ?? [],
        continues_from_previous_page: false, continues_on_next_page: false,
      }];
    }
    let raw = parseJsonContent(messageContent);
    // Some compatible models collapse a one-question verification to the inner object.
    // Re-wrap only after the inner object itself passes the same strict production schema.
    if (options.mode === "verify" && raw && typeof raw === "object" && !Array.isArray(raw) && !("questions" in raw)) {
      raw = { paper_id: options.paperId, page: options.page, questions: [extractedQuestionSchema.parse(raw)] };
    }
    const parsed = visionResultSchema.parse(raw);
    if (parsed.paper_id !== options.paperId || parsed.page !== options.page) {
      throw new Error("Vision result paper/page identity mismatch");
    }
    return parsed.questions;
  }

  async locateFigures(images: Buffer[], options: {
    paperId: string; questionNo: string; stemMarkdown: string; promptVersion: string;
  }): Promise<FigureLocation[]> {
    if (images.length < 1 || images.length > 3) throw new Error("Figure location requires 1 to 3 source-page images");
    const prompt = `你是试卷题图定位器。只定位题号 ${options.questionNo} 对应的原始图形，不转录题目、不解题。
输入图片按 image_index 从 0 开始编号，可能包含相邻题目、页眉、页码和选项。
目标题干：${options.stemMarkdown}

严格要求：
1. 只框选该题真正需要在 Markdown 中保留的几何图、函数图象、统计图、表格或插图。
2. 不要框选题干文字、选项、题号、页码、章节标题、横线或相邻题目的图。
3. 边界框应紧贴完整图形，同时包含图内坐标轴、点名、角度、尺寸和“图1/图2”等图内标签。
4. 同一题的相邻子图可用一个完整边界框；相距很远时可返回多个框。
5. 如果无法可靠定位，返回空 figures，不要猜。
6. bbox_1000 为 [x1,y1,x2,y2]，坐标相对各自图片归一化到 0..1000。
7. 只输出严格 JSON：{"figures":[{"image_index":0,"bbox_1000":[0,0,1000,1000],"confidence":0.95,"kind":"geometry|chart|table|illustration|other"}]}
paper_id=${options.paperId}; prompt_version=${options.promptVersion}`;
    const content: Array<Record<string, unknown>> = [
      { type: "text", text: prompt },
      ...images.map((image) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } })),
    ];
    const parsed = figureLocationResponseSchema.parse(parseJsonContent(await this.complete(content, 2_048)));
    return parsed.figures.map((figure) => {
      const [x1, y1, x2, y2] = figure.bbox_1000;
      if ([x1, y1, x2, y2].some((value) => value < 0 || value > 1_000) || x2 <= x1 || y2 <= y1) {
        throw new Error("Figure locator returned an invalid normalized bounding box");
      }
      return { imageIndex: figure.image_index, bbox1000: [x1, y1, x2, y2],
        confidence: figure.confidence, kind: figure.kind };
    });
  }

  private async complete(content: Array<Record<string, unknown>>, maxTokens: number): Promise<string> {
    assertVisionConfigured();
    const payload = {
      model: this.model,
      messages: [{ role: "user", content }],
      stream: false,
      max_tokens: maxTokens,
      temperature: 0.1,
      response_format: { type: "json_object" },
      ...thinkingParameter(this.model),
    };
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${config.API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json() as ChatResponse;
    if (!response.ok) throw new Error(`Vision API ${response.status}: ${redactText(body.error?.message ?? "request failed")}`);
    const message = body.choices?.[0]?.message;
    if (!message?.content) throw new Error("Vision API returned no content");
    if (message.reasoning_content?.trim() || /<think>[\s\S]*?<\/think>/i.test(message.content)) {
      throw new Error("Vision provider returned reasoning content; strict transcription rejected it");
    }
    return message.content;
  }
}
