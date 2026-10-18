import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { PdfDocument } from "../src/pdf/pdf-document.js";
import { analyzeRegion } from "../src/pdf/region-raster.js";
import { planQuestionRegions } from "../src/pdf/text-layout.js";

/** Minimal one-page PDF: two numbered questions in Helvetica and a stroked rectangle "figure" under question 1. */
function buildPdf(): Buffer {
  const content = [
    "BT /F1 12 Tf 20 360 Td (1. Which figure is shown below?) Tj ET",
    "40 230 100 100 re S",
    "BT /F1 12 Tf 20 190 Td (2. Name the second shape here.) Tj ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let output = "%PDF-1.4\n"; const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(output.length); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

describe("PdfDocument", () => {
  it("renders pages locally and aligns the text layer with the raster", async () => {
    const document = await PdfDocument.open(buildPdf());
    try {
      expect(document.pageCount).toBe(1);
      const text = await document.extractText(1, 2);
      expect(text.lines.map((line) => line.text)).toEqual(["1. Which figure is shown below?", "2. Name the second shape here."]);
      expect(text.reliable).toBe(true);
      const { png, width, height } = await document.renderPage(1, 2);
      expect([width, height]).toEqual([600, 800]);

      const { data, info } = await sharp(png).flatten({ background: "white" }).greyscale().raw().toBuffer({ resolveWithObject: true });
      const raster = { data, width: info.width, height: info.height };
      const [first, second] = planQuestionRegions([text]).regions;
      const figure = analyzeRegion(raster, first!, first!.lines.flatMap((line) => line.items));
      expect(figure.residualInkRatio).toBeGreaterThan(0.001);
      expect(figure.figures).toHaveLength(1);
      // The rectangle spans x 80..280 and y 140..340 at scale 2; boxes are padded by 10px.
      expect(figure.figures[0]).toMatchObject({ left: 69, top: 129, right: 291, bottom: 351 });
      const plain = analyzeRegion(raster, second!, second!.lines.flatMap((line) => line.items));
      expect(plain.residualInkRatio).toBe(0);
      expect(plain.figures).toEqual([]);
    } finally { await document.close(); }
  });
});
