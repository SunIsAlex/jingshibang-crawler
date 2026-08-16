import { config } from "../config.js";

type Level = "debug" | "info" | "warn" | "error";

const priorities: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const secretKeyPattern = /cookie|authorization|token|session|api[_-]?key|phone|mobile|openid/i;

export function redactText(input: string): string {
  return input
    .replace(/([?&](?:token|access_token|session|authorization)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]")
    .replace(/1[3-9]\d{9}/g, "[REDACTED_PHONE]");
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretKeyPattern.test(key) ? "[REDACTED]" : redactValue(item),
      ]),
    );
  }
  return value;
}

export class Logger {
  log(level: Level, event: string, meta: Record<string, unknown> = {}): void {
    if (priorities[level] < priorities[config.LOG_LEVEL]) return;
    const safeMeta = redactValue(meta) as Record<string, unknown>;
    const suffix = Object.keys(safeMeta).length ? ` ${JSON.stringify(safeMeta)}` : "";
    const line = `[${event}]${suffix}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  debug(event: string, meta?: Record<string, unknown>): void { this.log("debug", event, meta); }
  info(event: string, meta?: Record<string, unknown>): void { this.log("info", event, meta); }
  warn(event: string, meta?: Record<string, unknown>): void { this.log("warn", event, meta); }
  error(event: string, meta?: Record<string, unknown>): void { this.log("error", event, meta); }
}

export const logger = new Logger();
