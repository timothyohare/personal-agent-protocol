import { appendFileSync } from "node:fs";

// One-line, human-readable protocol events (N6) that never contain secrets (N5, T-16).

/** Field names whose values are always replaced. Matched case-insensitively. */
const SECRET_FIELDS = new Set([
  "access_token", "refresh_token", "account_token", "session_token", "token", "code", "code_verifier",
  "dpop", "authorization", "assertion", "client_assertion", "d", "password", "proof", "private_key", "csrf",
]);

/** Anything that looks like a JWT, wherever it appears. */
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g;

export function redact(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_FIELDS.has(key.toLowerCase())) return "[redacted]";
  if (typeof value === "string") return value.replace(JWT_RE, "[jwt]");
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

export type LogSink = (line: string) => void;

/** Prints to stdout, and also appends to $POPPY_LOG_FILE when set (scanned by scripts/check-logs.ts). */
export function processSink(env: Record<string, string | undefined> = process.env): LogSink {
  const file = env.POPPY_LOG_FILE;
  return (line) => {
    console.log(line);
    if (file) appendFileSync(file, `${line}\n`);
  };
}

export interface Logger {
  event(name: string, fields?: Record<string, unknown>): void;
}

/** A logger that prints `[component] event key=value …`, with secrets redacted. */
export function createLogger(component: string, sink: LogSink = (l) => console.log(l)): Logger {
  return {
    event(name, fields = {}) {
      const parts = Object.entries(redact(fields) as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
      sink([`[${component}]`, name, ...parts].join(" "));
    },
  };
}

export const silentLogger: Logger = { event() {} };
