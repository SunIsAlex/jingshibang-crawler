import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { config } from "../src/config.js";
import { OpenAICompatibleVisionProvider } from "../src/vision/openai.js";

const fixture = await readFile(new URL("../tests/fixtures/question-crop.svg", import.meta.url));
const image = await sharp(fixture).png().toBuffer();
const provider = new OpenAICompatibleVisionProvider();
const startedAt = Date.now();
const questions = await provider.extractQuestion([image], {
  paperId: "vision-provider-probe",
  page: 1,
  promptVersion: config.VISION_PROMPT_VERSION,
});

console.log(JSON.stringify({
  ok: true,
  model: provider.model,
  questionCount: questions.length,
  schemaValidated: true,
  elapsedMs: Date.now() - startedAt,
  sample: questions.map((question) => ({
    number: question.number,
    type: question.type,
    confidence: question.confidence,
    uncertainRegionCount: question.uncertain_regions.length,
  })),
}, null, 2));
