import { expect, test } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateAgentKeys, readPrivateJwk, readPublicJwk } from "../../../scripts/keys.ts";

test("genkeys writes a 0600 private JWK and a public JWK with a kid, and doesn't overwrite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "poppy-keys-"));
  const a = await generateAgentKeys(dir);
  expect(a.created).toBe(true);
  expect(statSync(join(dir, "agent-signing.private.json")).mode & 0o777).toBe(0o600);
  const pub = readPublicJwk(dir);
  expect(pub).not.toHaveProperty("d");
  expect(pub.kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
  expect(readPrivateJwk(dir)).toHaveProperty("d");
  expect(readPrivateJwk(dir).kid).toBe(pub.kid);
  const b = await generateAgentKeys(dir);
  expect(b).toEqual({ publicJwk: pub, created: false });
  expect((await generateAgentKeys(dir, true)).publicJwk.kid).not.toBe(pub.kid);
});

test("the default keys/ directory is git-ignored", () => {
  const out = execFileSync("git", ["check-ignore", "keys/agent-signing.private.json"], { encoding: "utf8" });
  expect(out.trim()).toBe("keys/agent-signing.private.json");
});
