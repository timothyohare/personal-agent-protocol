import { describe, expect, test } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import {
  DpopError, MemoryReplayStore, dpopProof, jwkThumbprint, newDpopKey, normalizeHtu, verifyDpop,
} from "../src/index.ts";

const URL_ = "https://tipping.example/api/fixtures";
const TOKEN = "opaque-session-token-abc";
const now = () => Math.floor(Date.now() / 1000);
const store = () => new MemoryReplayStore();

async function rejects(p: Promise<unknown>, re: RegExp, code = "invalid_dpop_proof") {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(DpopError);
  expect((e as DpopError).code).toBe(code);
  expect((e as Error).message).toMatch(re);
}

describe("verifyDpop: accepts", () => {
  test("a valid proof, returning the RFC 7638 thumbprint", async () => {
    const k = await newDpopKey();
    const jkt = await verifyDpop(await dpopProof(k, "GET", URL_, { accessToken: TOKEN }), "GET", URL_, store(),
      { accessToken: TOKEN });
    expect(jkt).toBe(await jwkThumbprint(k.publicJwk));
  });

  test("a proof from the key the token is bound to", async () => {
    const k = await newDpopKey();
    const jkt = await jwkThumbprint(k.publicJwk);
    await verifyDpop(await dpopProof(k, "GET", URL_, { accessToken: TOKEN }), "GET", URL_, store(),
      { accessToken: TOKEN, boundJkt: jkt });
  });

  test("iat within skew tolerance (+3 s)", async () => {
    const k = await newDpopKey();
    await verifyDpop(await dpopProof(k, "GET", URL_, { iat: now() + 3 }), "GET", URL_, store());
  });

  test("iat 50 s old", async () => {
    const k = await newDpopKey();
    await verifyDpop(await dpopProof(k, "GET", URL_, { iat: now() - 50 }), "GET", URL_, store());
  });

  test("the matching nonce", async () => {
    const k = await newDpopKey();
    await verifyDpop(await dpopProof(k, "GET", URL_, { nonce: "n1" }), "GET", URL_, store(), { nonce: "n1" });
  });

  test("a query string on the request URL (htu ignores it)", async () => {
    const k = await newDpopKey();
    await verifyDpop(await dpopProof(k, "GET", `${URL_}?round=3`), "GET", `${URL_}?round=7`, store());
  });

  test("typ in another valid spelling (S5 F4)", async () => {
    const k = await newDpopKey();
    await verifyDpop(await dpopProof(k, "GET", URL_, { typ: "application/dpop+jwt" }), "GET", URL_, store());
  });
});

describe("verifyDpop: rejects", () => {
  test("a missing proof", async () => {
    await rejects(verifyDpop(undefined, "GET", URL_, store()), /missing/);
    await rejects(verifyDpop("", "GET", URL_, store()), /missing/);
  });

  test("N1: a replayed jti", async () => {
    const k = await newDpopKey(); const r = store();
    const p = await dpopProof(k, "GET", URL_);
    await verifyDpop(p, "GET", URL_, r);
    await rejects(verifyDpop(p, "GET", URL_, r), /replay/);
  });

  test("N1b: the same jti in a fresh proof", async () => {
    const k = await newDpopKey(); const r = store();
    await verifyDpop(await dpopProof(k, "GET", URL_, { jti: "j".repeat(22) }), "GET", URL_, r);
    await rejects(verifyDpop(await dpopProof(k, "GET", URL_, { jti: "j".repeat(22) }), "GET", URL_, r), /replay/);
  });

  test("N2: a proof from a different key than the token is bound to", async () => {
    const k1 = await newDpopKey(); const k2 = await newDpopKey();
    const bound = await jwkThumbprint(k1.publicJwk);
    await rejects(verifyDpop(await dpopProof(k2, "GET", URL_, { accessToken: TOKEN }), "GET", URL_, store(),
      { accessToken: TOKEN, boundJkt: bound }), /not bound/);
  });

  test("N3: htm mismatch", async () => {
    const k = await newDpopKey();
    await rejects(verifyDpop(await dpopProof(k, "POST", URL_), "GET", URL_, store()), /htm/);
  });

  test("N3b: htu mismatch", async () => {
    const k = await newDpopKey();
    await rejects(verifyDpop(await dpopProof(k, "GET", "https://tipping.example/api/ladder"), "GET", URL_, store()),
      /htu/);
  });

  test("N4: iat 120 s old", async () => {
    const k = await newDpopKey();
    await rejects(verifyDpop(await dpopProof(k, "GET", URL_, { iat: now() - 120 }), "GET", URL_, store()), /iat|age/);
  });

  test("N4b: iat 60 s in the future", async () => {
    const k = await newDpopKey();
    await rejects(verifyDpop(await dpopProof(k, "GET", URL_, { iat: now() + 60 }), "GET", URL_, store()), /iat/);
  });

  test("N4c: iat 10 s in the future (beyond the 5 s skew)", async () => {
    const k = await newDpopKey();
    await rejects(verifyDpop(await dpopProof(k, "GET", URL_, { iat: now() + 10 }), "GET", URL_, store()), /iat/);
  });

  test("N5: ath mismatch (proof made for another token)", async () => {
    const k = await newDpopKey();
    await rejects(verifyDpop(await dpopProof(k, "GET", URL_, { accessToken: "other" }), "GET", URL_, store(),
      { accessToken: TOKEN }), /ath/);
  });

  test("N5b: ath missing when a token is presented", async () => {
    const k = await newDpopKey();
    await rejects(verifyDpop(await dpopProof(k, "GET", URL_), "GET", URL_, store(), { accessToken: TOKEN }), /ath/);
  });

  test("N6: a private key (d) in the jwk header", async () => {
    const k = await newDpopKey();
    const priv = await exportJWK(k.privateKey);
    await rejects(verifyDpop(await dpopProof(k, "GET", URL_, { headerJwk: priv }), "GET", URL_, store()), /./);
  });

  test("N7: wrong typ", async () => {
    const k = await newDpopKey();
    await rejects(verifyDpop(await dpopProof(k, "GET", URL_, { typ: "JWT" }), "GET", URL_, store()), /typ/);
  });

  test("N8: alg none", async () => {
    const k = await newDpopKey();
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = b64({ htm: "GET", htu: URL_, jti: "x".repeat(22), iat: now() });
    await rejects(verifyDpop(`${b64({ typ: "dpop+jwt", alg: "none", jwk: k.publicJwk })}.${body}.`, "GET", URL_,
      store()), /./);
  });

  test("N8b: HS256 with an oct key", async () => {
    const hs = await new SignJWT({ htm: "GET", htu: URL_, jti: "y".repeat(22) })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "HS256", jwk: { kty: "oct", k: "c2VjcmV0" } as unknown as JWK })
      .setIssuedAt().sign(new TextEncoder().encode("secret"));
    await rejects(verifyDpop(hs, "GET", URL_, store()), /./);
  });

  test("N9: header jwk differs from the signing key (signature fails)", async () => {
    const k = await newDpopKey(); const other = await newDpopKey();
    await rejects(verifyDpop(await dpopProof(k, "GET", URL_, { headerJwk: other.publicJwk }), "GET", URL_, store()),
      /signature/);
  });

  test("N10: missing iat", async () => {
    const k = await newDpopKey();
    const p = await new SignJWT({ htm: "GET", htu: URL_, jti: "z".repeat(22) })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: k.publicJwk }).sign(k.privateKey);
    await rejects(verifyDpop(p, "GET", URL_, store()), /iat/);
  });

  test("N11: nonce required but absent gives use_dpop_nonce", async () => {
    const k = await newDpopKey();
    await rejects(verifyDpop(await dpopProof(k, "GET", URL_), "GET", URL_, store(), { nonce: "n1" }), /nonce/,
      "use_dpop_nonce");
  });

  test("N11b: wrong nonce gives use_dpop_nonce", async () => {
    const k = await newDpopKey();
    await rejects(verifyDpop(await dpopProof(k, "GET", URL_, { nonce: "n0" }), "GET", URL_, store(), { nonce: "n1" }),
      /nonce/, "use_dpop_nonce");
  });

  test("N13: a short jti (15 chars)", async () => {
    const k = await newDpopKey();
    await rejects(verifyDpop(await dpopProof(k, "GET", URL_, { jti: "a".repeat(15) }), "GET", URL_, store()), /jti/);
  });

  test("N13b: a 16-char jti is accepted", async () => {
    const k = await newDpopKey();
    await verifyDpop(await dpopProof(k, "GET", URL_, { jti: "a".repeat(16) }), "GET", URL_, store());
  });

  test("N13c: a non-string jti", async () => {
    const k = await newDpopKey();
    const p = await new SignJWT({ htm: "GET", htu: URL_, jti: 12345678901234567890 } as Record<string, unknown>)
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: k.publicJwk }).setIssuedAt().sign(k.privateKey);
    await rejects(verifyDpop(p, "GET", URL_, store()), /jti/);
  });

  test("N14: a valid EdDSA proof is rejected by the ES256 pin", async () => {
    const ed = await generateKeyPair("EdDSA", { extractable: true });
    const p = await new SignJWT({ htm: "GET", htu: URL_, jti: "e".repeat(22) })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "EdDSA", jwk: await exportJWK(ed.publicKey) })
      .setIssuedAt().sign(ed.privateKey);
    await rejects(verifyDpop(p, "GET", URL_, store()), /alg/);
  });
});

describe("verifyDpop: check order", () => {
  test("N12: a rejected proof does not burn its jti", async () => {
    const k = await newDpopKey(); const r = store();
    const p = await dpopProof(k, "GET", URL_, { accessToken: TOKEN });
    await rejects(verifyDpop(p, "GET", URL_, r, { accessToken: "wrong" }), /ath/);
    await verifyDpop(p, "GET", URL_, r, { accessToken: TOKEN });
  });

  test("a proof rejected for its key binding does not burn its jti", async () => {
    const k = await newDpopKey(); const r = store();
    const p = await dpopProof(k, "GET", URL_);
    await rejects(verifyDpop(p, "GET", URL_, r, { boundJkt: "other" }), /bound/);
    await verifyDpop(p, "GET", URL_, r, { boundJkt: await jwkThumbprint(k.publicJwk) });
  });

  test("a proof rejected for its nonce does not burn its jti", async () => {
    const k = await newDpopKey(); const r = store();
    const p = await dpopProof(k, "GET", URL_, { nonce: "n1" });
    await rejects(verifyDpop(p, "GET", URL_, r, { nonce: "n2" }), /nonce/, "use_dpop_nonce");
    await verifyDpop(p, "GET", URL_, r, { nonce: "n1" });
  });
});

describe("dpopProof", () => {
  test("puts htm, normalised htu, jti, iat, ath and nonce in the claims", async () => {
    const k = await newDpopKey();
    const p = await dpopProof(k, "POST", "HTTPS://Tipping.Example/api/x?q=1#f", { accessToken: TOKEN, nonce: "nn" });
    const [h, b] = p.split(".").slice(0, 2).map((s) => JSON.parse(Buffer.from(s!, "base64url").toString()));
    expect(h).toMatchObject({ typ: "dpop+jwt", alg: "ES256", jwk: k.publicJwk });
    expect(b.htm).toBe("POST");
    expect(b.htu).toBe("https://tipping.example/api/x");
    expect(b.jti.length).toBeGreaterThanOrEqual(22);
    expect(b.nonce).toBe("nn");
    expect(typeof b.ath).toBe("string");
    expect(Math.abs(b.iat - now())).toBeLessThan(5);
  });

  test("omits ath and nonce when not given", async () => {
    const k = await newDpopKey();
    const b = JSON.parse(Buffer.from((await dpopProof(k, "GET", URL_)).split(".")[1]!, "base64url").toString());
    expect(b).not.toHaveProperty("ath");
    expect(b).not.toHaveProperty("nonce");
  });

  test("newDpopKey keys are extractable and publish only the public JWK", async () => {
    const k = await newDpopKey();
    expect(k.publicJwk).not.toHaveProperty("d");
    expect(await exportJWK(k.privateKey)).toHaveProperty("d");
  });
});

test("htu normalisation rules", () => {
  expect(normalizeHtu("HTTPS://Tipping.Example:443/api/fixtures?round=32#x")).toBe(URL_);
  expect(normalizeHtu("https://tipping.example:8443/api/fixtures")).toBe("https://tipping.example:8443/api/fixtures");
  expect(normalizeHtu("http://localhost:80/a")).toBe("http://localhost/a");
  expect(normalizeHtu("https://tipping.example/api/fixtures/")).not.toBe(URL_); // trailing slash is significant
  expect(normalizeHtu("https://tipping.example/API/fixtures")).not.toBe(URL_); // path is case-sensitive
  expect(normalizeHtu("https://tipping.example/api/%7Efixtures")).toBe("https://tipping.example/api/%7Efixtures");
});

describe("verifyDpop: more edges", () => {
  test("a proof carrying a nonce is accepted when no nonce is required", async () => {
    const k = await newDpopKey();
    await verifyDpop(await dpopProof(k, "GET", URL_, { nonce: "n1" }), "GET", URL_, store());
  });

  test("two different proofs verify against the same replay store", async () => {
    const k = await newDpopKey(); const r = store();
    await verifyDpop(await dpopProof(k, "GET", URL_), "GET", URL_, r);
    await verifyDpop(await dpopProof(k, "GET", URL_), "GET", URL_, r);
  });

  test("records the jti for 70 s (max age plus twice the skew)", async () => {
    const calls: [string, number][] = [];
    const spy = { checkAndAdd: async (key: string, ttl: number) => { calls.push([key, ttl]); return true; } };
    const k = await newDpopKey();
    await verifyDpop(await dpopProof(k, "GET", URL_, { jti: "q".repeat(20) }), "GET", URL_, spy);
    expect(calls).toEqual([[`dpop:${"q".repeat(20)}`, 70_000]]);
  });

  test("errors are DpopErrors by name", async () => {
    const e = await verifyDpop(undefined, "GET", URL_, store()).catch((x: Error) => x);
    expect((e as Error).name).toBe("DpopError");
  });
});
