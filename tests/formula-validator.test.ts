import { describe, expect, it } from "vitest";
import { FormulaValidator } from "../src/parsing/formula-validator.js";

const validator = new FormulaValidator();
describe("FormulaValidator", () => {
  it("accepts structured LaTeX", () => expect(validator.validate("$f(x)=\\frac{a+b}{c+d}+\\sqrt{x+1}$").valid).toBe(true));
  it("rejects unpaired delimiters and incomplete braces", () => {
    const result = validator.validate("$\\frac{a}{b"); expect(result.valid).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("unpaired-dollar"); expect(codes).toContain("unbalanced-braces");
  });
  it("uses visual radical hint", () => expect(validator.validate("$x+1$", { hasRadical: true }).issues[0]?.code).toBe("missing-radical"));
});
