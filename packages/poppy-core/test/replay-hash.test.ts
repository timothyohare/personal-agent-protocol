import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { MemoryReplayStore, PoppyError, pkceChallenge, pkceVerifier, rid, sha256b64url } from "../src/index.ts";

test("replay store: a new key is accepted once within its TTL", async () => {
  const s = new MemoryReplayStore();
  expect(await s.checkAndAdd("a", 1000)).toBe(true);
  expect(await s.checkAndAdd("a", 1000)).toBe(false);
  expect(await s.checkAndAdd("b", 1000)).toBe(true);
});

test("replay store: a key is accepted again after it expires", async () => {
  let t = 0;
  const s = new MemoryReplayStore({ now: () => t });
  await s.checkAndAdd("a", 1000);
  t = 999;
  expect(await s.checkAndAdd("a", 1000)).toBe(false);
  t = 1000;
  expect(await s.checkAndAdd("a", 1000)).toBe(true);
});

test("replay store: expired entries are evicted when full, and it refuses when still full", async () => {
  let t = 0;
  const s = new MemoryReplayStore({ maxEntries: 2, now: () => t });
  await s.checkAndAdd("a", 10);
  await s.checkAndAdd("b", 100);
  t = 50;
  expect(await s.checkAndAdd("c", 100)).toBe(true); // "a" evicted
  expect(s.size).toBe(2);
  await expect(s.checkAndAdd("d", 100)).rejects.toThrow(/full/);
});

test("rid is base64url with 128 bits by default", () => {
  expect(rid()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(rid(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(rid()).not.toBe(rid());
});

test("sha256b64url matches node:crypto", () => {
  expect(sha256b64url("abc")).toBe(createHash("sha256").update("abc").digest("base64url"));
  expect(sha256b64url("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
});

test("PKCE: RFC 7636 appendix B example", () => {
  expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  expect(pkceVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("PoppyError carries code, status and detail", () => {
  const e = new PoppyError("invalid_grant", 400, "code reused");
  expect(e).toMatchObject({ code: "invalid_grant", status: 400, detail: "code reused", message: "invalid_grant: code reused" });
  expect(new PoppyError("x", 401).message).toBe("x");
});

test("replay store: an entry expiring exactly now is evicted when full", async () => {
  let t = 0;
  const s = new MemoryReplayStore({ maxEntries: 1, now: () => t });
  await s.checkAndAdd("a", 10);
  t = 10;
  expect(await s.checkAndAdd("b", 10)).toBe(true);
});

test("PoppyError has its name", () => {
  expect(new PoppyError("x", 400).name).toBe("PoppyError");
});
