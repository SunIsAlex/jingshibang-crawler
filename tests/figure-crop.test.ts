import { describe, expect, it } from "vitest";
import { findInkSnappedBox } from "../src/vision/figure-asset-refiner.js";

describe("figure crop ink snapping", () => {
  it("selects the figure band intersecting the model seed and excludes adjacent text", () => {
    const width = 100; const height = 200;
    const pixels = new Uint8Array(width * height).fill(255);
    const inkRow = (y: number, from: number, to: number) => {
      for (let x = from; x <= to; x += 1) pixels[y * width + x] = 0;
    };
    for (let y = 20; y <= 30; y += 1) inkRow(y, 10, 90); // preceding text
    for (let y = 70; y <= 130; y += 1) { pixels[y * width + 20] = 0; pixels[y * width + 80] = 0; }
    inkRow(70, 20, 80); inkRow(130, 20, 80); // figure edges
    for (let y = 155; y <= 165; y += 1) inkRow(y, 5, 95); // following text

    expect(findInkSnappedBox(pixels, width, height, 75, 140)).toEqual({
      left: 20, top: 70, right: 81, bottom: 131,
    });
  });
});
