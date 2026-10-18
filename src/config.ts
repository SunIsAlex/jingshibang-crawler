import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const envSchema = z.object({
  API_KEY: z.string().default(""),
  API_URL: z.string().url().default("https://api.example.com/v1"),
  VISION_MODEL: z.string().default("Qwen/Qwen3-VL-32B-Instruct"),
  VISION_PROMPT_VERSION: z.string().default("v1"),
  VISION_DISABLE_THINKING: booleanString,
  VISION_THINKING_PARAM_MODE: z.enum(["auto", "always", "never"]).default("auto"),
  MAX_VISION_REQUESTS_PER_RUN: z.coerce.number().int().min(0).default(100),
  MAX_VISION_IMAGES_PER_RUN: z.coerce.number().int().min(0).default(200),
  PREVIEW_SOURCE: z.enum(["auto", "pdf", "canvas"]).default("auto"),
  PDF_TEXT_MODE: z.enum(["auto", "hint", "off"]).default("auto"),
  PDF_RENDER_SCALE: z.coerce.number().min(1).max(5).default(2.5),
  PDF_CAPTURE_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),
  MAX_DOWNLOADS_PER_DAY: z.coerce.number().int().min(0).default(0),
  REQUEST_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(1),
  REQUEST_DELAY_MIN_MS: z.coerce.number().int().min(0).default(800),
  REQUEST_DELAY_MAX_MS: z.coerce.number().int().min(0).default(1500),
  REQUEST_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  HEADLESS: booleanString,
  BROWSER_CHANNEL: z.string().default("chrome"),
  BROWSER_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(60_000),
  AUTH_STATE_PATH: z.string().default(".local/auth-state.json"),
  DATABASE_PATH: z.string().default("data/jingshibang.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const env = envSchema.parse(process.env);
const root = process.cwd();

if (env.REQUEST_DELAY_MAX_MS < env.REQUEST_DELAY_MIN_MS) {
  throw new Error("REQUEST_DELAY_MAX_MS must be >= REQUEST_DELAY_MIN_MS");
}

export const config = {
  ...env,
  root,
  authStatePath: path.resolve(root, env.AUTH_STATE_PATH),
  databasePath: path.resolve(root, env.DATABASE_PATH),
  dataDir: path.resolve(root, "data"),
  pdfDir: path.resolve(root, "data/pdfs"),
  rawPagesDir: path.resolve(root, "data/raw-pages"),
  questionCropsDir: path.resolve(root, "data/question-crops"),
  formulaCropsDir: path.resolve(root, "data/formula-crops"),
  assetsDir: path.resolve(root, "data/assets"),
  cacheDir: path.resolve(root, "data/cache"),
  outputDir: path.resolve(root, "output"),
} as const;

export type AppConfig = typeof config;

export function assertVisionConfigured(): void {
  if (!config.API_KEY || config.API_URL === "https://api.example.com/v1") {
    throw new Error("Vision API is not configured. Set API_KEY and API_URL in .env.");
  }
}
