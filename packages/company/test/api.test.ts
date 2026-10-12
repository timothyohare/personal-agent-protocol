import { describe, expect, test } from "vitest";
import { dpopProof, newDpopKey, type DpopKey } from "poppy-core";
import { MemoryVault, dpopKeyFor } from "agent";
import { COMPANY, testbed } from "../../../test-support/testbed.ts";

const FIX = `${COMPANY}/api/fixtures`;

async function setup(opts: Parameters<typeof testbed>[0] = {}) {
  const tb = await testbed(opts);
  const vault = new MemoryVault();
  const client = tb.client(vault);
  const s = await client.startSession();
  const key = await dpopKeyFor(vault, COMPANY);
  async function get(url: string, over: { token?: string | null; proof?: string | null; key?: DpopKey; method?: string;
    scheme?: string } = {}) {
    const token = over.token === null ? undefined : over.token ?? s.token;
    const method = over.method ?? "GET";
    const proof = over.proof === null ? undefined
      : over.proof ?? await dpopProof(over.key ?? key, method, url, token ? { accessToken: token } : {});
    const res = await tb.fetch(url, { method, headers: {
      ...(token ? { authorization: `${over.scheme ?? "DPoP"} ${token}` } : {}), ...(proof ? { dpop: proof } : {}) } });
    return { res, json: await res.json().catch(() => null) as Record<string, unknown> };
  }
  return { tb, client, s, key, get };
}

function expectAuthError(r: { res: Response; json: Record<string, unknown> }, status: number, error: string) {
  expect({ status: r.res.status, error: r.json.error }).toEqual({ status, error });
  const www = r.res.headers.get("www-authenticate")!;
  expect(www).toMatch(/^DPoP /);
  expect(www).toContain(`error="${error}"`);
}

describe("public API with a signed-out Session Token", () => {
  test("GET /api/fixtures returns the current round", async () => {
    const { get } = await setup();
    const { res, json } = await get(FIX);
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ round: 27, current_round: 27 });
    expect((json.fixtures as unknown[]).length).toBe(8);
  });

  test("GET /api/fixtures?round=28 (the query isn't part of htu)", async () => {
    const { get } = await setup();
    const { json } = await get(`${FIX}?round=28`);
    expect(json.round).toBe(28);
    expect((json.fixtures as { home: string }[])[0]!.home).toBe("Broncos");
  });

  test("a bad round is 400", async () => {
    const { get } = await setup();
    expect((await get(`${FIX}?round=abc`)).res.status).toBe(400);
  });

  test("GET /api/ladder", async () => {
    const { get } = await setup();
    const { res, json } = await get(`${COMPANY}/api/ladder`);
    expect(res.status).toBe(200);
    expect((json.ladder as { team: string; points: number }[])[0]).toMatchObject({ team: "Storm", points: 40 });
  });

  test("the agent's call() works end to end", async () => {
    const { client } = await setup();
    const r = await client.call("GET", "/api/fixtures");
    expect(r.status).toBe(200);
    expect(r.error).toBeUndefined();
  });
});

describe("rejections (F5): 401 with WWW-Authenticate: DPoP", () => {
  test("A-01: a replayed proof", async () => {
    const { get, key, s } = await setup();
    const proof = await dpopProof(key, "GET", FIX, { accessToken: s.token });
    expect((await get(FIX, { proof })).res.status).toBe(200);
    expectAuthError(await get(FIX, { proof }), 401, "invalid_dpop_proof");
  });

  test("A-02: the token with no DPoP header", async () => {
    const { get } = await setup();
    expectAuthError(await get(FIX, { proof: null }), 401, "invalid_dpop_proof");
  });

  test("A-03: the token with a proof from a different key", async () => {
    const { get } = await setup();
    expectAuthError(await get(FIX, { key: await newDpopKey() }), 401, "invalid_dpop_proof");
  });

  test("A-06: wrong htm or htu", async () => {
    const { get, key, s } = await setup();
    expectAuthError(await get(FIX, { proof: await dpopProof(key, "POST", FIX, { accessToken: s.token }) }), 401,
      "invalid_dpop_proof");
    expectAuthError(await get(FIX, { proof: await dpopProof(key, "GET", `${COMPANY}/api/ladder`,
      { accessToken: s.token }) }), 401, "invalid_dpop_proof");
  });

  test("A-07: iat 120 s old, or 60 s in the future", async () => {
    const { get, key, s } = await setup();
    const now = Math.floor(Date.now() / 1000);
    for (const iat of [now - 120, now + 60]) {
      expectAuthError(await get(FIX, { proof: await dpopProof(key, "GET", FIX, { accessToken: s.token, iat }) }), 401,
        "invalid_dpop_proof");
    }
  });

  test("ath for another token", async () => {
    const { get, key } = await setup();
    expectAuthError(await get(FIX, { proof: await dpopProof(key, "GET", FIX, { accessToken: "other" }) }), 401,
      "invalid_dpop_proof");
  });

  test("A-24: alg none and a private jwk in the header", async () => {
    const { get, key, s } = await setup();
    const { exportJWK } = await import("jose");
    expectAuthError(await get(FIX, { proof: await dpopProof(key, "GET", FIX,
      { accessToken: s.token, headerJwk: await exportJWK(key.privateKey) }) }), 401, "invalid_dpop_proof");
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b64({ typ: "dpop+jwt", alg: "none", jwk: key.publicJwk })}.${b64({ htm: "GET", htu: FIX,
      jti: "x".repeat(22), iat: Math.floor(Date.now() / 1000) })}.`;
    expectAuthError(await get(FIX, { proof: none }), 401, "invalid_dpop_proof");
  });

  test("no token, an unknown token, a Bearer scheme", async () => {
    const { get, s } = await setup();
    expectAuthError(await get(FIX, { token: null }), 401, "invalid_token");
    expectAuthError(await get(FIX, { token: "nope" }), 401, "invalid_token");
    expectAuthError(await get(FIX, { scheme: "Bearer", token: s.token }), 401, "invalid_token");
  });

  test("A-42: a token in the URL is never accepted", async () => {
    const { get, s, key } = await setup();
    const url = `${FIX}?access_token=${s.token}`;
    expectAuthError(await get(url, { token: null, proof: await dpopProof(key, "GET", url, { accessToken: s.token }) }),
      401, "invalid_token");
  });

  test("an expired token, or an ended Session", async () => {
    const { get, s, tb } = await setup();
    tb.company.stores.tokens.get(s.token)!.expiresAt = Date.now() - 1;
    expectAuthError(await get(FIX), 401, "invalid_token");
    const two = await setup();
    two.tb.company.stores.sessions.get(two.s.sessionId)!.ended = true;
    expectAuthError(await two.get(FIX), 401, "invalid_token");
  });

  test("a rejected request is logged without the token or proof", async () => {
    const { get, tb, s } = await setup();
    await get(FIX, { proof: null });
    const all = tb.logs.join("\n");
    expect(all).toContain("api.rejected");
    expect(all).not.toContain(s.token);
  });
});

describe("DPoP nonces at APIs", () => {
  test("401 use_dpop_nonce with DPoP-Nonce, and the agent retries once", async () => {
    const { tb } = await setup({ company: { requireDpopNonce: true } });
    let apiGets = 0;
    const real = tb.hosts["tipping.example"]!;
    tb.hosts["tipping.example"] = { fetch: (r) => { if (r.url.includes("/api/")) apiGets++; return real.fetch(r); } };
    const client = tb.client();
    await client.startSession();
    // Forget the nonce learned at the token endpoint, so the API has to ask for it.
    (client as unknown as { nonces: Map<string, string> }).nonces.clear();
    expect((await client.call("GET", "/api/fixtures")).status).toBe(200);
    expect(apiGets).toBe(2);
  });

  test("a proof without the nonce gets use_dpop_nonce and a DPoP-Nonce header", async () => {
    const { get } = await setup({ company: { requireDpopNonce: true } });
    const r = await get(FIX);
    expectAuthError(r, 401, "use_dpop_nonce");
    expect(r.res.headers.get("dpop-nonce")).toBeTruthy();
  });
});

describe("agent call()", () => {
  test("starts a new Session after invalid_token and retries", async () => {
    const { client, tb, s } = await setup();
    tb.company.stores.tokens.delete(s.token);
    const r = await client.call("GET", "/api/ladder");
    expect(r.status).toBe(200);
    expect(client.session!.sessionId).not.toBe(s.sessionId);
  });

  test("honours a 429 Retry-After once", async () => {
    const { client, tb } = await setup();
    let n = 0;
    const real = tb.hosts["tipping.example"]!;
    tb.hosts["tipping.example"] = { fetch: (r) => (r.url.includes("/api/") && n++ === 0)
      ? new Response("{}", { status: 429, headers: { "retry-after": "3" } }) : real.fetch(r) };
    expect((await client.call("GET", "/api/ladder")).status).toBe(200);
    expect(tb.sleeps).toEqual([3000]);
  });

  test("refuses an absolute URL to another origin, and never puts the token in the URL", async () => {
    const { client, tb, s } = await setup();
    await expect(client.call("GET", "https://evil.example/x")).rejects.toThrow(/relative/);
    const urls: string[] = [];
    const real = tb.hosts["tipping.example"]!;
    tb.hosts["tipping.example"] = { fetch: (r) => { urls.push(r.url); return real.fetch(r); } };
    await client.call("GET", "/api/fixtures?round=28");
    expect(urls.join(" ")).not.toContain(s.token);
  });

  test("returns the error code from WWW-Authenticate", async () => {
    const { client, tb } = await setup();
    const real = tb.hosts["tipping.example"]!;
    tb.hosts["tipping.example"] = { fetch: (r) => r.url.includes("/api/")
      ? new Response("{}", { status: 403, headers: { "www-authenticate": 'DPoP error="insufficient_scope", scope="standings"' } })
      : real.fetch(r) };
    expect(await client.call("GET", "/api/me/score")).toMatchObject({ status: 403, error: "insufficient_scope",
      requiredScope: "standings" });
  });
});

test("/openapi.json describes every route", async () => {
  const { tb } = await setup();
  const doc = await (await tb.fetch(`${COMPANY}/openapi.json`)).json() as { openapi: string; paths: Record<string, object> };
  expect(doc.openapi).toBe("3.1.0");
  expect(Object.keys(doc.paths).sort()).toEqual(["/api/fixtures", "/api/ladder", "/api/me/score", "/api/me/tips"]);
});
