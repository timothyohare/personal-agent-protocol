import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jwkThumbprint } from "poppy-core";
import { FileVault, MemoryVault, dpopKeyFor, userIdFor } from "../src/index.ts";
import { COMPANY, testbed } from "../../../test-support/testbed.ts";

describe("CompanyClient.startSession", () => {
  test("gets a signed-out Session Token bound to the per-company DPoP key", async () => {
    const tb = await testbed();
    const vault = new MemoryVault();
    const c = tb.client(vault);
    const s = await c.startSession();
    expect(s).toMatchObject({ signedIn: false, scope: [] });
    expect(s.sessionId).toMatch(/^ses_/);
    const stored = tb.company.stores.tokens.get(s.token)!;
    expect(stored.jkt).toBe(await jwkThumbprint((await dpopKeyFor(vault, COMPANY)).publicJwk));
    expect(tb.company.stores.sessions.get(s.sessionId)!.userId).toBe(await userIdFor(vault, COMPANY));
  });

  test("renews the same Session with its session_id", async () => {
    const tb = await testbed();
    const c = tb.client();
    const first = await c.startSession();
    const second = await c.startSession({ renew: true });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.token).not.toBe(first.token);
  });

  test("retries once on use_dpop_nonce, using the DPoP-Nonce value (S4 G5)", async () => {
    const tb = await testbed({ company: { requireDpopNonce: true } });
    let posts = 0;
    const real = tb.hosts["tipping.example"]!;
    tb.hosts["tipping.example"] = { fetch: (r) => { if (r.method === "POST") posts++; return real.fetch(r); } };
    await tb.client().startSession();
    expect(posts).toBe(2);
  });

  test("honours 429 Retry-After once, then succeeds (S4 G6)", async () => {
    const tb = await testbed();
    let n = 0;
    const real = tb.hosts["tipping.example"]!;
    tb.hosts["tipping.example"] = { fetch: (r) => (r.method === "POST" && n++ === 0)
      ? Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "2" } }) : real.fetch(r) };
    await tb.client().startSession();
    expect(tb.sleeps).toEqual([2000]);
  });

  test("a non-DPoP token_type is refused", async () => {
    const tb = await testbed();
    const real = tb.hosts["tipping.example"]!;
    tb.hosts["tipping.example"] = { fetch: async (r) => {
      const res = await real.fetch(r);
      if (r.method !== "POST") return res;
      return Response.json({ ...(await res.json() as object), token_type: "Bearer" });
    } };
    await expect(tb.client().startSession()).rejects.toThrow(/token_type/);
  });
});

describe("per-company identity (F2)", () => {
  test("the User ID is random, per issuer, and reused across runs", async () => {
    const vault = new MemoryVault();
    const a = await userIdFor(vault, "https://a.example");
    expect(a).toMatch(/^u_[A-Za-z0-9_-]{22}$/);
    expect(await userIdFor(vault, "https://a.example")).toBe(a);
    expect(await userIdFor(vault, "https://b.example")).not.toBe(a);
  });

  test("the DPoP key is per issuer and survives a reload from the vault", async () => {
    const vault = new MemoryVault();
    const a1 = await dpopKeyFor(vault, "https://a.example");
    const a2 = await dpopKeyFor(vault, "https://a.example");
    expect(await jwkThumbprint(a2.publicJwk)).toBe(await jwkThumbprint(a1.publicJwk));
    expect(a2.publicJwk).not.toHaveProperty("d");
    const b = await dpopKeyFor(vault, "https://b.example");
    expect(await jwkThumbprint(b.publicJwk)).not.toBe(await jwkThumbprint(a1.publicJwk));
  });
});

describe("FileVault", () => {
  const paths = () => {
    const dir = mkdtempSync(join(tmpdir(), "poppy-vault-"));
    return { file: join(dir, "vault.json"), key: join(dir, "vault.key") };
  };

  test("round-trips values, encrypted at rest with 0600 files", async () => {
    const p = paths();
    const v = new FileVault(p.file, p.key);
    expect(await v.get("x")).toBeUndefined();
    await v.set("account_token:x", "super-secret-refresh-token");
    await v.set("other", "1");
    expect(await new FileVault(p.file, p.key).get("account_token:x")).toBe("super-secret-refresh-token");
    expect(readFileSync(p.file, "utf8")).not.toContain("super-secret");
    expect(statSync(p.file).mode & 0o777).toBe(0o600);
    expect(statSync(p.key).mode & 0o777).toBe(0o600);
    await v.delete("account_token:x");
    expect(await v.get("account_token:x")).toBeUndefined();
    expect(await v.get("other")).toBe("1");
  });

  test("a different key can't read it, and a tampered file is rejected", async () => {
    const p = paths();
    await new FileVault(p.file, p.key).set("a", "b");
    const other = paths();
    await expect(new FileVault(p.file, other.key).get("a")).rejects.toThrow();
    const blob = JSON.parse(readFileSync(p.file, "utf8"));
    blob.data = Buffer.from("tampered").toString("base64");
    writeFileSync(p.file, JSON.stringify(blob));
    await expect(new FileVault(p.file, p.key).get("a")).rejects.toThrow();
  });

  test("refuses a key file of the wrong length", () => {
    const p = paths();
    writeFileSync(p.key, "short");
    expect(() => new FileVault(p.file, p.key)).toThrow(/32 bytes/);
  });
});
