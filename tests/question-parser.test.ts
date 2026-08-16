import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { productDetailResponseSchema, productsResponseSchema } from "../src/parsing/schemas.js";

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures", name), "utf8"));

describe("site response schemas", () => {
  it("parses observed product list shape", () => expect(productsResponseSchema.parse(fixture("products.json")).data[0]?.id).toBe("123456"));
  it("parses observed detail shape", () => expect(productDetailResponseSchema.parse(fixture("paper-detail.json")).data.storeInfo.store_subject).toBe("数学"));
});
