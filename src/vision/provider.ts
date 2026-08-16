import type { ExtractedQuestion } from "../parsing/schemas.js";

export interface VisionExtractOptions {
  paperId: string;
  page: number;
  promptVersion: string;
  mode?: "extract" | "verify" | "formula";
  firstResult?: ExtractedQuestion[];
  mimeTypes?: string[];
}

export interface FigureLocation {
  imageIndex: number;
  bbox1000: [number, number, number, number];
  confidence: number;
  kind: "geometry" | "chart" | "table" | "illustration" | "other";
}

export interface VisionProvider {
  readonly model: string;
  extractQuestion(images: Buffer[], options: VisionExtractOptions): Promise<ExtractedQuestion[]>;
  locateFigures?(images: Buffer[], options: {
    paperId: string; questionNo: string; stemMarkdown: string; promptVersion: string;
  }): Promise<FigureLocation[]>;
}
