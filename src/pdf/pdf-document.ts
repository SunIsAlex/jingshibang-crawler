import path from "node:path";
import { createRequire } from "node:module";
import { groupTextLines, repairPdfText, textQuality, type PdfPageText, type PdfTextItem } from "./text-layout.js";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfLoadingTask = ReturnType<PdfJs["getDocument"]>;
type PdfDocumentProxy = Awaited<PdfLoadingTask["promise"]>;

let pdfjsModule: Promise<PdfJs> | null = null;
const loadPdfJs = () => (pdfjsModule ??= import("pdfjs-dist/legacy/build/pdf.mjs"));

function assetDirectory(name: string): string {
  const root = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  return path.join(root, name) + path.sep;
}

/** Local, offline PDF access. Rendering and text extraction never touch the network. */
export class PdfDocument {
  private constructor(private readonly pdfjs: PdfJs, private readonly task: PdfLoadingTask, private readonly document: PdfDocumentProxy) {}

  static async open(buffer: Buffer): Promise<PdfDocument> {
    const pdfjs = await loadPdfJs();
    const task = pdfjs.getDocument({
      // pdf.js transfers the array it is given; keep the caller's buffer intact.
      data: new Uint8Array(buffer),
      cMapUrl: assetDirectory("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: assetDirectory("standard_fonts"),
      wasmUrl: assetDirectory("wasm"),
      verbosity: 0,
    });
    return new PdfDocument(pdfjs, task, await task.promise);
  }

  get pageCount(): number { return this.document.numPages; }

  async renderPage(pageNo: number, scale: number): Promise<{ png: Buffer; width: number; height: number }> {
    const page = await this.document.getPage(pageNo);
    try {
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width); const height = Math.ceil(viewport.height);
      const factory = this.document.canvasFactory as {
        create(width: number, height: number): { canvas: { toBuffer(type: "image/png"): Buffer }; context: unknown };
        destroy(target: unknown): void;
      };
      const target = factory.create(width, height);
      try {
        await page.render({
          canvas: target.canvas as unknown as HTMLCanvasElement,
          canvasContext: target.context as CanvasRenderingContext2D,
          viewport,
          background: "#ffffff",
        }).promise;
        return { png: target.canvas.toBuffer("image/png"), width, height };
      } finally { factory.destroy(target); }
    } finally { page.cleanup(); }
  }

  /** Text layer in the pixel space of renderPage(pageNo, scale). */
  async extractText(pageNo: number, scale: number): Promise<PdfPageText> {
    const page = await this.document.getPage(pageNo);
    try {
      const viewport = page.getViewport({ scale });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str) continue;
        const transform = this.pdfjs.Util.transform(viewport.transform, item.transform) as number[];
        const fontSize = Math.hypot(transform[2]!, transform[3]!);
        if (!fontSize) continue;
        const left = transform[4]!; const baseline = transform[5]!;
        items.push({
          text: repairPdfText(item.str), fontSize,
          left, right: left + item.width * scale,
          // Generous glyph box: ascent ~1em above the baseline, descent ~0.25em below.
          top: baseline - fontSize, bottom: baseline + fontSize * 0.25,
        });
      }
      const lines = groupTextLines(items);
      return {
        pageNo, width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), lines,
        reliable: textQuality(lines.map((line) => line.text).join("")).reliable,
      };
    } finally { page.cleanup(); }
  }

  async close(): Promise<void> { await this.task.destroy(); }
}
