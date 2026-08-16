import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PageSegmenter } from "../src/vision/page-segmenter.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("PageSegmenter", () => {
  it("creates local crops from separated content bands", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jsb-segment-")); directories.push(directory);
    const crops = await new PageSegmenter(directory).segment(path.join(process.cwd(), "tests/fixtures/page-sample.svg"), "123", 1);
    expect(crops.length).toBeGreaterThanOrEqual(1); expect(crops.every((crop) => fs.existsSync(crop.path))).toBe(true);
    expect(crops.every((crop) => crop.height >= 100)).toBe(true);
  });
});
