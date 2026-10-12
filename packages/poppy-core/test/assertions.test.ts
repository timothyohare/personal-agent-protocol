import { beforeAll, describe, expect, test } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTVerifyGetKey } from "jose";
import {
  AssertionError, MemoryReplayStore, assertionReplayTtlMs, clientAssertion, sessionAssertion, verifyAssertion, type SigningKey,
} from "../src/index.ts";

const CLIENT = "https://agent.example/agent.json";
const TOKEN_EP = "https://tipping.example/oauth/token";
const USER = "u_7Hq2pXa9";
let key: SigningKey;
let jwks: JWTVerifyGetKey;
const now = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const kp = await generateKeyPair("ES256");
  key = { privateKey: kp.privateKey, kid: "k1" };
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "ES256" } as JWK] });
});

const opts = (extra: object = {}) => ({ issuer: CLIENT, audience: TOKEN_EP, replay: new MemoryReplayStore(), ...extra });

async function rejects(p: Promise<unknown>, re: RegExp) {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(AssertionError);
  expect((e as Error).message).toMatch(re);
}

/** Builds an assertion with any claim overridden or removed (`undefined`). */
async function custom(claims: Record<string, unknown>, k: SigningKey = key, alg = "ES256") {
  const base: Record<string, unknown> = {
    iss: CLIENT, sub: USER, aud: TOKEN_EP, iat: now(), exp: now() + 60, jti: "j".repeat(22), ...claims,
  };
  for (const [n, v] of Object.entries(base)) if (v === undefined) delete base[n];
  return new SignJWT(base).setProtectedHeader({ alg, kid: k.kid }).sign(k.privateKey);
}

describe("accepts", () => {
  test("a session assertion, returning sub and jti", async () => {
    const p = await verifyAssertion(await sessionAssertion(CLIENT, USER, TOKEN_EP, key), jwks, opts());
    expect(p.sub).toBe(USER);
    expect(p.jti.length).toBeGreaterThanOrEqual(16);
  });

  test("a client assertion with sub = client_id", async () => {
    await verifyAssertion(await clientAssertion(CLIENT, TOKEN_EP, key), jwks, opts({ subject: CLIENT }));
  });

  test("assertions carry a 60 s lifetime and the kid", async () => {
    const jwt = await clientAssertion(CLIENT, TOKEN_EP, key);
    const [h, b] = jwt.split(".").slice(0, 2).map((s) => JSON.parse(Buffer.from(s, "base64url").toString()));
    expect(h).toMatchObject({ alg: "ES256", kid: "k1" });
    expect(b.exp - b.iat).toBe(60);
    expect(b).toMatchObject({ iss: CLIENT, sub: CLIENT, aud: TOKEN_EP });
  });
});

describe("rejects", () => {
  test("a missing assertion", async () => {
    await rejects(verifyAssertion(undefined, jwks, opts()), /missing/);
  });

  test("a wrong iss", async () => {
    await rejects(verifyAssertion(await custom({ iss: "https://evil.example/agent.json" }), jwks, opts()), /iss/);
  });

  test("a wrong aud (another company's token endpoint)", async () => {
    await rejects(verifyAssertion(await custom({ aud: "https://other.example/oauth/token" }), jwks, opts()), /aud/);
  });

  test("an array aud, even one containing ours", async () => {
    await rejects(verifyAssertion(await custom({ aud: [TOKEN_EP, "https://other.example/oauth/token"] }), jwks, opts()),
      /single string/);
    await rejects(verifyAssertion(await custom({ aud: [TOKEN_EP] }), jwks, opts()), /single string/);
  });

  test("an expired exp", async () => {
    await rejects(verifyAssertion(await custom({ iat: now() - 120, exp: now() - 30 }), jwks, opts()), /exp/);
  });

  test("a missing exp", async () => {
    await rejects(verifyAssertion(await custom({ exp: undefined }), jwks, opts()), /exp/);
  });

  test("a missing iat", async () => {
    await rejects(verifyAssertion(await custom({ iat: undefined }), jwks, opts()), /iat/);
  });

  test("an iat older than the maximum age, even with a far exp", async () => {
    await rejects(verifyAssertion(await custom({ iat: now() - 600, exp: now() + 600 }), jwks, opts()), /iat|age/);
  });

  test("a reused jti", async () => {
    const o = opts();
    const jwt = await sessionAssertion(CLIENT, USER, TOKEN_EP, key);
    await verifyAssertion(jwt, jwks, o);
    await rejects(verifyAssertion(jwt, jwks, o), /replay/);
  });

  test("a missing or short jti", async () => {
    await rejects(verifyAssertion(await custom({ jti: undefined }), jwks, opts()), /jti/);
    await rejects(verifyAssertion(await custom({ jti: "short" }), jwks, opts()), /jti/);
  });

  test("a missing sub", async () => {
    await rejects(verifyAssertion(await custom({ sub: undefined }), jwks, opts()), /sub/);
  });

  test("an empty sub", async () => {
    await rejects(verifyAssertion(await custom({ sub: "" }), jwks, opts()), /sub/);
  });

  test("a client assertion whose sub isn't the client_id", async () => {
    await rejects(verifyAssertion(await custom({ sub: USER }), jwks, opts({ subject: CLIENT })), /sub/);
  });

  test("a key not in the JWKS", async () => {
    const other = await generateKeyPair("ES256");
    await rejects(verifyAssertion(await custom({}, { privateKey: other.privateKey, kid: "k1" }), jwks, opts()),
      /signature/);
  });

  test("a kid not in the JWKS", async () => {
    const other = await generateKeyPair("ES256");
    await rejects(verifyAssertion(await custom({}, { privateKey: other.privateKey, kid: "nope" }), jwks, opts()),
      /key/i);
  });

  test("a non-ES256 algorithm (ES384)", async () => {
    const kp = await generateKeyPair("ES384");
    const set = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k384" } as JWK] });
    await rejects(verifyAssertion(await custom({}, { privateKey: kp.privateKey, kid: "k384" }, "ES384"), set, opts()),
      /alg/);
  });
});

test("a rejected assertion does not burn its jti", async () => {
  const o = opts();
  const jwt = await sessionAssertion(CLIENT, USER, TOKEN_EP, key);
  await rejects(verifyAssertion(jwt, jwks, { ...o, audience: "https://other.example/oauth/token" }), /aud/);
  await verifyAssertion(jwt, jwks, o);
});

test("jtis from different issuers don't collide", async () => {
  const replay = new MemoryReplayStore();
  await verifyAssertion(await custom({ jti: "same".repeat(5) }), jwks, { issuer: CLIENT, audience: TOKEN_EP, replay });
  const other = "https://agent2.example/agent.json";
  await verifyAssertion(await custom({ iss: other, jti: "same".repeat(5) }), jwks,
    { issuer: other, audience: TOKEN_EP, replay });
});

describe("more edges", () => {
  test("a 16-char jti is accepted (the minimum)", async () => {
    await verifyAssertion(await custom({ jti: "m".repeat(16) }), jwks, opts());
  });

  test("a non-string jti or sub", async () => {
    await rejects(verifyAssertion(await custom({ jti: 12345678901234567890 }), jwks, opts()), /jti/);
    await rejects(verifyAssertion(await custom({ sub: 1234 }), jwks, opts()), /sub/);
  });

  test("the jti is remembered until exp plus skew", async () => {
    const calls: [string, number][] = [];
    const replay = { checkAndAdd: async (key: string, ttl: number) => { calls.push([key, ttl]); return true; } };
    const before = Date.now();
    await verifyAssertion(await custom({ jti: "r".repeat(20) }), jwks, { issuer: CLIENT, audience: TOKEN_EP, replay });
    const [[key, ttl]] = calls as [[string, number]];
    expect(key).toBe(`assertion:${CLIENT}:${"r".repeat(20)}`);
    expect(ttl).toBeGreaterThan(60_000);
    expect(ttl).toBeLessThanOrEqual(66_000 + (Date.now() - before));
  });

  test("assertionReplayTtlMs", () => {
    expect(assertionReplayTtlMs(100, 50_000)).toBe(55_000);
    expect(assertionReplayTtlMs(100, 104_500)).toBe(1000);
    expect(assertionReplayTtlMs(100, 103_000)).toBe(2000);
  });

  test("errors are AssertionErrors by name", async () => {
    const e = await verifyAssertion(undefined, jwks, opts()).catch((x: Error) => x);
    expect((e as Error).name).toBe("AssertionError");
  });
});
