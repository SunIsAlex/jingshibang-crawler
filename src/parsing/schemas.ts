import { z } from "zod";

export const questionTypeSchema = z.enum([
  "single_choice",
  "multiple_choice",
  "fill_blank",
  "short_answer",
  "proof",
  "true_false",
  "unknown",
]);

export const extractedOptionSchema = z.object({
  label: z.string().min(1).max(8),
  markdown: z.string(),
}).strict();

export const extractedImageSchema = z.object({
  type: z.enum(["geometry", "chart", "table", "illustration", "other"]),
  path: z.string().default(""),
  description: z.string().optional(),
}).strict();

export const extractedQuestionSchema = z.object({
  number: z.union([z.string(), z.number()]).transform(String),
  type: questionTypeSchema.default("unknown"),
  stem_markdown: z.string().min(1),
  options: z.array(extractedOptionSchema).default([]),
  images: z.array(extractedImageSchema).default([]),
  confidence: z.number().min(0).max(1),
  uncertain_regions: z.array(z.string()).default([]),
  continues_from_previous_page: z.boolean().default(false),
  continues_on_next_page: z.boolean().default(false),
}).strict();

export const visionResultSchema = z.object({
  paper_id: z.string().min(1),
  page: z.number().int().positive(),
  questions: z.array(extractedQuestionSchema),
}).strict();

export type ExtractedOption = z.infer<typeof extractedOptionSchema>;
export type ExtractedImage = z.infer<typeof extractedImageSchema>;
export type ExtractedQuestion = z.infer<typeof extractedQuestionSchema>;
export type VisionResult = z.infer<typeof visionResultSchema>;

export const paperListItemSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  store_name: z.string(),
  add_time: z.string().optional().default(""),
  store_type: z.string().optional().default(""),
  store_subject: z.string().optional().default(""),
  store_grade: z.string().optional().default(""),
  district: z.string().optional().default(""),
  intersection: z.string().optional().default(""),
  have_answer: z.string().optional().default(""),
  browse: z.number().optional(),
  upload_num: z.number().optional(),
  count: z.number().optional(),
}).passthrough();

export const productsResponseSchema = z.object({
  status: z.number(),
  msg: z.string(),
  data: z.array(paperListItemSchema),
}).passthrough();

export const storeInfoSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  store_name: z.string(),
  add_time: z.string().optional().default(""),
  store_type: z.string().optional().default(""),
  store_subject: z.string().optional().default(""),
  store_grade: z.string().optional().default(""),
  district: z.string().optional().default(""),
  intersection: z.string().optional().default(""),
  pdf_paper: z.string().optional().default(""),
  pdf_answer: z.string().optional().default(""),
  word_paper: z.string().optional().default(""),
  word_answer: z.string().optional().default(""),
  have_answer: z.string().optional().default(""),
  paper_type: z.string().optional().default(""),
  browse: z.number().optional(),
  upload_num: z.number().optional(),
}).passthrough();

export const productDetailResponseSchema = z.object({
  status: z.number(),
  msg: z.string(),
  data: z.object({ storeInfo: storeInfoSchema }).passthrough(),
}).passthrough();

export type PaperListItem = z.infer<typeof paperListItemSchema>;
export type StoreInfo = z.infer<typeof storeInfoSchema>;
