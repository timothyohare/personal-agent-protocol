import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "../src");

test("spec 4.4 / S4 E4: the agent library contains no login or consent form automation", () => {
  for (const f of readdirSync(SRC)) {
    const text = readFileSync(join(SRC, f), "utf8");
    expect({ f, hit: text.match(/password|csrf|username|login_form|approve=|consent_form/i)?.[0] ?? null })
      .toEqual({ f, hit: null });
  }
});

test("A-22: check-logs fails on a JWT or a 43-char token in the log, and passes on clean lines", () => {
  const run = (content: string) => {
    const file = join(mkdtempSync(join(tmpdir(), "poppy-logs-")), "x.log");
    writeFileSync(file, content);
    try {
      execFileSync("node", ["scripts/check-logs.ts"], { env: { ...process.env, POPPY_LOG_FILE: file }, stdio: "pipe" });
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };
  expect(run("[company] session.started session_id=ses_8qHmhi4f68l6CYXC6JTadA user_id=u_-UNcuKB90AaN3f23sWfLcA\n")).toBe(0);
  expect(run(`[company] x token=${"A".repeat(43)}\n`)).toBe(1);
  expect(run("[agent] x eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln\n")).toBe(1);
});
