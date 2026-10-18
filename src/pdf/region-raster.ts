import type { PixelBox } from "../vision/figure-asset-refiner.js";
import type { PdfTextItem } from "./text-layout.js";

export interface GreyRaster { data: Uint8Array; width: number; height: number }

export interface RegionAnalysis {
  /** Region tightened to the rows that actually contain ink. */
  top: number;
  bottom: number;
  empty: boolean;
  /** Share of region pixels that are ink not covered by any PDF text glyph box (figures, rules, fraction bars...). */
  residualInkRatio: number;
  /** Figure-sized clusters of non-text ink, in page pixel coordinates. */
  figures: PixelBox[];
}

const darkThreshold = 200;

export function analyzeRegion(raster: GreyRaster, band: { top: number; bottom: number }, textItems: PdfTextItem[]): RegionAnalysis {
  const { data, width, height } = raster;
  const top = Math.max(0, Math.floor(band.top)); const bottom = Math.min(height, Math.ceil(band.bottom));
  const rows = Math.max(0, bottom - top);
  const masked = new Uint8Array(width * rows);
  for (const item of textItems) {
    const x1 = Math.max(0, Math.floor(item.left) - 2); const x2 = Math.min(width, Math.ceil(item.right) + 2);
    const y1 = Math.max(top, Math.floor(item.top) - 2); const y2 = Math.min(bottom, Math.ceil(item.bottom) + 2);
    for (let y = y1; y < y2; y += 1) masked.fill(1, (y - top) * width + x1, (y - top) * width + x2);
  }
  let firstInk = -1; let lastInk = -1; let residual = 0;
  const residualRows = new Uint32Array(rows);
  for (let y = top; y < bottom; y += 1) {
    let rowInk = false;
    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x]! >= darkThreshold) continue;
      rowInk = true;
      if (!masked[(y - top) * width + x]) { residual += 1; residualRows[y - top] = residualRows[y - top]! + 1; }
    }
    if (rowInk) { if (firstInk < 0) firstInk = y; lastInk = y + 1; }
  }
  if (firstInk < 0) return { top, bottom, empty: true, residualInkRatio: 0, figures: [] };

  const figures: PixelBox[] = [];
  let start = -1; let lastRow = -1;
  const flush = () => {
    if (start < 0 || lastRow - start + 1 < 40) return;
    let left = width; let right = -1;
    for (let y = top + start; y <= top + lastRow; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[y * width + x]! < darkThreshold && !masked[(y - top) * width + x]) { left = Math.min(left, x); right = Math.max(right, x + 1); }
      }
    }
    if (right - left < 40) return;
    figures.push(includeLabels({ left, top: top + start, right, bottom: top + lastRow + 1 }, textItems, width, height));
  };
  for (let row = 0; row <= rows; row += 1) {
    if (row < rows && residualRows[row]! > 0) { if (start < 0) start = row; lastRow = row; continue; }
    if (start >= 0 && (row === rows || row - lastRow > 12)) { flush(); start = -1; }
  }
  return { top: firstInk, bottom: lastInk, empty: false, residualInkRatio: residual / Math.max(1, width * rows), figures };
}

/** Grow a figure box so short in-figure labels (point names, axis labels) are not cut off. */
function includeLabels(box: PixelBox, items: PdfTextItem[], width: number, height: number): PixelBox {
  const output = { ...box };
  for (const item of items) {
    if (item.text.trim().length > 3) continue;
    const reach = item.fontSize;
    const near = item.right >= box.left - reach && item.left <= box.right + reach && item.bottom >= box.top - reach && item.top <= box.bottom + reach;
    if (!near) continue;
    output.left = Math.min(output.left, item.left); output.right = Math.max(output.right, item.right);
    output.top = Math.min(output.top, item.top); output.bottom = Math.max(output.bottom, item.bottom);
  }
  const padding = 10;
  return {
    left: Math.max(0, Math.floor(output.left) - padding), top: Math.max(0, Math.floor(output.top) - padding),
    right: Math.min(width, Math.ceil(output.right) + padding), bottom: Math.min(height, Math.ceil(output.bottom) + padding),
  };
}
