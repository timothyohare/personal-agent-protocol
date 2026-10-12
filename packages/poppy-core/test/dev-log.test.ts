import { expect, test } from "vitest";
import { createLogger, devAllowHttpLocalhost, isAllowedUrl, redact } from "../src/index.ts";

test("dev flag: off by default, on with 1, refused in production", () => {
  expect(devAllowHttpLocalhost({})).toBe(false);
  expect(devAllowHttpLocalhost({ POPPY_DEV_ALLOW_HTTP_LOCALHOST: "true" })).toBe(false);
  expect(devAllowHttpLocalhost({ POPPY_DEV_ALLOW_HTTP_LOCALHOST: "1" })).toBe(true);
  expect(devAllowHttpLocalhost({ NODE_ENV: "production" })).toBe(false);
  expect(() => devAllowHttpLocalhost({ POPPY_DEV_ALLOW_HTTP_LOCALHOST: "1", NODE_ENV: "production" })).toThrow(/production/);
});

test("isAllowedUrl", () => {
  expect(isAllowedUrl("https://agent.example/agent.json", false)).toBe(true);
  expect(isAllowedUrl("http://agent.example/agent.json", false)).toBe(false);
  expect(isAllowedUrl("http://agent.example/agent.json", true)).toBe(false);
  expect(isAllowedUrl("http://localhost:8788/agent.json", false)).toBe(false);
  expect(isAllowedUrl("http://localhost:8788/agent.json", true)).toBe(true);
  expect(isAllowedUrl("http://127.0.0.1:8788/agent.json", true)).toBe(true);
  expect(isAllowedUrl("http://[::1]:8788/agent.json", true)).toBe(true);
  expect(isAllowedUrl("http://LOCALHOST/x", true)).toBe(true);
  expect(isAllowedUrl("ftp://localhost/x", true)).toBe(false);
  expect(isAllowedUrl("https://user:pw@agent.example/", false)).toBe(false);
  expect(isAllowedUrl("https://user@agent.example/", false)).toBe(false);
  expect(isAllowedUrl("not a url", true)).toBe(false);
});

test("redact: secret fields, nested objects, arrays and JWT-shaped strings", () => {
  const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";
  expect(redact({ access_token: "abc", Code: "c", nested: { d: "priv", ok: 1 }, list: [jwt], note: `x ${jwt} y` }))
    .toEqual({ access_token: "[redacted]", Code: "[redacted]", nested: { d: "[redacted]", ok: 1 }, list: ["[jwt]"],
      note: "x [jwt] y" });
  expect(redact(5)).toBe(5);
  expect(redact(null)).toBe(null);
});

test("logger prints one narrated line without secrets", () => {
  const lines: string[] = [];
  const log = createLogger("company", (l) => lines.push(l));
  log.event("session.started", { session_id: "ses_1", access_token: "secret-token", signed_in: false, skip: undefined });
  log.event("plain");
  expect(lines).toEqual(["[company] session.started session_id=ses_1 access_token=[redacted] signed_in=false",
    "[company] plain"]);
});

test("default logger writes to console.log", () => {
  const orig = console.log; const seen: unknown[] = [];
  console.log = (x: unknown) => seen.push(x);
  try { createLogger("a").event("e"); } finally { console.log = orig; }
  expect(seen).toEqual(["[a] e"]);
});

test("processSink appends to POPPY_LOG_FILE when set", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { processSink } = await import("../src/index.ts");
  const file = join(mkdtempSync(join(tmpdir(), "poppy-log-")), "x.log");
  const orig = console.log; console.log = () => {};
  try {
    processSink({ POPPY_LOG_FILE: file })("one");
    processSink({ POPPY_LOG_FILE: file })("two");
    processSink({})("three");
  } finally { console.log = orig; }
  expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
});

test("redact covers every secret field name", () => {
  const names = ["access_token", "refresh_token", "account_token", "session_token", "token", "code", "code_verifier",
    "dpop", "authorization", "assertion", "client_assertion", "d", "password", "proof", "private_key", "csrf"];
  const out = redact(Object.fromEntries(names.map((n) => [n, "v"]))) as Record<string, string>;
  expect(Object.values(out).every((v) => v === "[redacted]")).toBe(true);
  expect(redact({ session_id: "ses_1", scope: "a b" })).toEqual({ session_id: "ses_1", scope: "a b" });
});

test("logger prints non-string values as JSON", () => {
  const lines: string[] = [];
  createLogger("x", (l) => lines.push(l)).event("e", { n: 1, o: { a: 1 }, l: ["a"] });
  expect(lines).toEqual(['[x] e n=1 o={"a":1} l=["a"]']);
});

test("processSink prints to the console", async () => {
  const { processSink } = await import("../src/index.ts");
  const seen: unknown[] = [];
  const orig = console.log; console.log = (x: unknown) => seen.push(x);
  try { processSink({})("hello"); } finally { console.log = orig; }
  expect(seen).toEqual(["hello"]);
});
