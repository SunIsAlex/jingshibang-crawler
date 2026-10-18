import { describe, expect, it } from "vitest";
import { assembleRanges, isPdfBuffer, parseContentRange, safeSourceUrl } from "../src/pdf/pdf-capture.js";

describe("passive PDF capture helpers", () => {
  it("recognizes PDF bytes", () => {
    expect(isPdfBuffer(Buffer.from("%PDF-1.7\n..."))).toBe(true);
    expect(isPdfBuffer(Buffer.from('{"url":"x"}'))).toBe(false);
  });

  it("assembles complete HTTP 206 chunk sets only", () => {
    const file = Buffer.from("%PDF-0123456789");
    expect(parseContentRange("bytes 5-9/15")).toEqual({ start: 5, end: 9, total: 15 });
    expect(parseContentRange("bytes 9-5/15")).toBeNull();
    const chunks = [{ start: 8, buffer: file.subarray(8) }, { start: 0, buffer: file.subarray(0, 10) }];
    expect(assembleRanges(file.length, chunks)?.equals(file)).toBe(true);
    expect(assembleRanges(file.length, [{ start: 0, buffer: file.subarray(0, 6) }, { start: 8, buffer: file.subarray(8) }])).toBeNull();
  });

  it("never keeps temporary preview credentials in stored URLs", () => {
    const url = safeSourceUrl("https://www.jingshibang.com/api/public/filepreview?product_id=1&type=answer&token=abc&Signature=xyz");
    expect(url).not.toMatch(/abc|xyz/);
    expect(url).toContain("product_id=1");
  });
});
