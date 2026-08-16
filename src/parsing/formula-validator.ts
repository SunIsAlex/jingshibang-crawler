export interface FormulaIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface FormulaValidationResult {
  valid: boolean;
  confidencePenalty: number;
  issues: FormulaIssue[];
}

const mathEnvironmentPattern = /\\(begin|end)\{(cases|matrix|pmatrix|bmatrix|aligned|align)\}/g;

function countUnescaped(input: string, char: string): number {
  let count = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === char && input[index - 1] !== "\\") count += 1;
  }
  return count;
}

function balancedBraces(input: string): boolean {
  let depth = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === "{" && input[index - 1] !== "\\") depth += 1;
    if (input[index] === "}" && input[index - 1] !== "\\") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function validateEnvironments(input: string): boolean {
  const stack: string[] = [];
  for (const match of input.matchAll(mathEnvironmentPattern)) {
    const action = match[1];
    const environment = match[2]!;
    if (action === "begin") stack.push(environment);
    else if (stack.pop() !== environment) return false;
  }
  return stack.length === 0;
}

export class FormulaValidator {
  validate(markdown: string, visualHints: { hasRadical?: boolean; hasFractionBar?: boolean } = {}): FormulaValidationResult {
    const issues: FormulaIssue[] = [];
    const add = (code: string, message: string, severity: FormulaIssue["severity"] = "error") => {
      issues.push({ code, message, severity });
    };

    if (countUnescaped(markdown, "$") % 2 !== 0) add("unpaired-dollar", "数学公式的 $ 分隔符未配对");
    if (!balancedBraces(markdown)) add("unbalanced-braces", "LaTeX 花括号未配对");
    if ((markdown.match(/\\left\b/g)?.length ?? 0) !== (markdown.match(/\\right\b/g)?.length ?? 0)) {
      add("unpaired-left-right", "\\left 与 \\right 数量不一致");
    }
    if (!validateEnvironments(markdown)) add("unbalanced-environment", "LaTeX begin/end 环境未正确嵌套");

    for (const command of markdown.matchAll(/\\(frac|dfrac|tfrac)\b/g)) {
      const tail = markdown.slice((command.index ?? 0) + command[0].length);
      if (!/^\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*\{/.test(tail)) {
        add("invalid-frac", `${command[0]} 缺少明确的两个花括号参数`);
      }
    }
    for (const command of markdown.matchAll(/\\sqrt(?:\[[^\]]+\])?/g)) {
      const tail = markdown.slice((command.index ?? 0) + command[0].length);
      if (!/^\s*\{/.test(tail)) add("invalid-sqrt", "\\sqrt 缺少明确的花括号作用范围");
    }

    if (visualHints.hasRadical && !markdown.includes("\\sqrt")) {
      add("missing-radical", "图像疑似含根号，但转录结果没有 \\sqrt", "warning");
    }
    if (visualHints.hasFractionBar && !/\\(?:d?frac|tfrac)\b/.test(markdown)) {
      add("missing-fraction", "图像疑似含分式横线，但转录结果没有 \\frac", "warning");
    }

    const confidencePenalty = Math.min(
      0.6,
      issues.reduce((sum, issue) => sum + (issue.severity === "error" ? 0.15 : 0.08), 0),
    );
    return { valid: issues.every((issue) => issue.severity !== "error"), confidencePenalty, issues };
  }
}
