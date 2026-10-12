import { describe, expect, test } from "vitest";
import { SignJWT, importJWK, type CryptoKey } from "jose";
import {
  clientAssertion, dpopProof, jwkThumbprint, newDpopKey, PoppyError, rid, sessionAssertion, type SigningKey,
} from "poppy-core";
import { GRANT_JWT_BEARER, CLIENT_ASSERTION_TYPE } from "../src/index.ts";
import { TOKEN_EP, edit, testbed } from "../../../test-support/testbed.ts";

const USER = "u_testuser0000000";

async function setup(opts: Parameters<typeof testbed>[0] = {}) {
  const tb = await testbed(opts);
  const dpop = await newDpopKey();
  const key: SigningKey = { privateKey: await importJWK(tb.agent.keys.privateJwk, "ES256") as CryptoKey,
    kid: tb.agent.keys.privateJwk.kid! };
  /** A raw token request; every part can be overridden. */
  async function post(over: {
    form?: Record<string, string | undefined>; proof?: string | null; clientId?: string; signingKey?: SigningKey;
    contentType?: string; userId?: string;
  } = {}) {
    const clientId = over.clientId ?? tb.agent.clientId;
    const k = over.signingKey ?? key;
    const form: Record<string, string | undefined> = {
      grant_type: GRANT_JWT_BEARER,
      assertion: await sessionAssertion(clientId, over.userId ?? USER, TOKEN_EP, k),
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(clientId, TOKEN_EP, k),
      ...over.form,
    };
    const body = new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined) as [string, string][]);
    const proof = over.proof === null ? undefined : over.proof ?? await dpopProof(dpop, "POST", TOKEN_EP);
    const res = await tb.fetch(TOKEN_EP, {
      method: "POST", body,
      headers: { "content-type": over.contentType ?? "application/x-www-form-urlencoded", ...(proof ? { dpop: proof } : {}) },
    });
    return { res, json: await res.json() as Record<string, unknown> };
  }
  return { tb, dpop, key, post };
}

const expectError = (r: { res: Response; json: Record<string, unknown> }, status: number, error: string) => {
  expect({ status: r.res.status, error: r.json.error }).toEqual({ status, error });
};

describe("JWT-bearer session start", () => {
  test("returns exactly the spec 4.2 response, signed out, with no-store", async () => {
    const { post } = await setup();
    const { res, json } = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(json).sort()).toEqual(["access_token", "expires_in", "scope", "session_id", "signed_in", "token_type"]);
    expect(json).toMatchObject({ token_type: "DPoP", expires_in: 3600, scope: "", signed_in: false });
    expect(json.session_id).toMatch(/^ses_[A-Za-z0-9_-]{22}$/);
    expect(json.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("stores the session (client, user, signed out) and binds the token to the proof's key", async () => {
    const { post, tb, dpop } = await setup();
    const { json } = await post();
    const s = (await tb.company.stores.sessions.get(json.session_id as string))!;
    expect(s).toMatchObject({ clientId: tb.agent.clientId, userId: USER, accountId: null, ended: false });
    const t = (await tb.company.stores.tokens.get(json.access_token as string))!;
    expect(t).toMatchObject({ sessionId: s.id, jkt: await jwkThumbprint(dpop.publicJwk), accountId: null, scope: [] });
    expect(t.expiresAt - Date.now()).toBeGreaterThan(3590_000);
  });

  test("logs a narrated line without the token", async () => {
    const { post, tb } = await setup();
    const { json } = await post();
    const line = tb.logs.find((l) => l.includes("session.started"))!;
    expect(line).toContain(String(json.session_id));
    expect(tb.logs.join("\n")).not.toContain(String(json.access_token));
  });
});

describe("client authentication (401 invalid_client)", () => {
  test("missing client assertion or wrong assertion type", async () => {
    const { post } = await setup();
    expectError(await post({ form: { client_assertion: undefined } }), 401, "invalid_client");
    expectError(await post({ form: { client_assertion_type: "x" } }), 401, "invalid_client");
  });

  test("malformed client assertion", async () => {
    const { post } = await setup();
    expectError(await post({ form: { client_assertion: "not.a.jwt" } }), 401, "invalid_client");
  });

  test("client_id parameter that differs from the assertion", async () => {
    const { post } = await setup();
    expectError(await post({ form: { client_id: "https://other.example/agent.json" } }), 401, "invalid_client");
  });

  test("client_id not HTTPS (no dev flag)", async () => {
    const { post } = await setup();
    expectError(await post({ clientId: "http://agent.example/agent.json" }), 401, "invalid_client");
  });

  test("A-09: client assertion signed with a key not in jwks.json", async () => {
    const { post, tb } = await setup();
    const other = await tb.addAgent("other.example");
    const wrong = { privateKey: other.identity.signingKey.privateKey, kid: tb.agent.keys.privateJwk.kid! };
    expectError(await post({ signingKey: wrong }), 401, "invalid_client");
  });

  test("metadata client_id mismatch", async () => {
    const { post, tb } = await setup();
    const real = tb.hosts["agent.example"]!;
    tb.hosts["agent.example"] = { fetch: async (req) => {
      const res = await real.fetch(req);
      if (!req.url.endsWith("/agent.json")) return res;
      return Response.json({ ...(await res.json() as object), client_id: "https://evil.example/agent.json" });
    } };
    expectError(await post(), 401, "invalid_client");
  });

  test("A-19: jwks_uri on a different host", async () => {
    const { post, tb } = await setup();
    const real = tb.hosts["agent.example"]!;
    tb.hosts["agent.example"] = { fetch: async (req) => {
      const res = await real.fetch(req);
      if (!req.url.endsWith("/agent.json")) return res;
      return Response.json({ ...(await res.json() as object), jwks_uri: "https://cdn.example/jwks.json" });
    } };
    expectError(await post(), 401, "invalid_client");
  });

  test("A-18: client_id at a literal internal address makes no request", async () => {
    const { post, tb } = await setup();
    let fetched = false;
    tb.hosts["169.254.169.254"] = { fetch: () => { fetched = true; return Response.json({}); } };
    tb.hosts["127.0.0.1"] = tb.hosts["169.254.169.254"];
    expectError(await post({ clientId: "https://169.254.169.254/agent.json" }), 401, "invalid_client");
    expectError(await post({ clientId: "https://127.0.0.1/agent.json" }), 401, "invalid_client");
    expect(fetched).toBe(false);
  });

  test("A-18: client_id whose host resolves to a private range makes no request", async () => {
    const { post, tb } = await setup({ company: { resolveHost: async () => ["10.1.2.3"] } });
    let fetched = false;
    const real = tb.hosts["agent.example"]!;
    tb.hosts["agent.example"] = { fetch: (r) => { fetched = true; return real.fetch(r); } };
    expectError(await post(), 401, "invalid_client");
    expect(fetched).toBe(false);
  });

  test("a reused client assertion jti", async () => {
    const { post, key, tb } = await setup();
    const ca = await clientAssertion(tb.agent.clientId, TOKEN_EP, key);
    expect((await post({ form: { client_assertion: ca } })).res.status).toBe(200);
    expectError(await post({ form: { client_assertion: ca } }), 401, "invalid_client");
  });

  test("a client assertion for another company's token endpoint", async () => {
    const { post, key, tb } = await setup();
    const ca = await clientAssertion(tb.agent.clientId, "https://other.example/oauth/token", key);
    expectError(await post({ form: { client_assertion: ca } }), 401, "invalid_client");
  });
});

describe("session assertion (400 invalid_grant)", () => {
  test("A-10: a reused session assertion jti", async () => {
    const { post, key, tb } = await setup();
    const a = await sessionAssertion(tb.agent.clientId, USER, TOKEN_EP, key);
    expect((await post({ form: { assertion: a } })).res.status).toBe(200);
    expectError(await post({ form: { assertion: a } }), 400, "invalid_grant");
  });

  test("A-11: aud of another company, or an array", async () => {
    const { post, key, tb } = await setup();
    expectError(await post({ form: { assertion: await sessionAssertion(tb.agent.clientId, USER,
      "https://other.example/oauth/token", key) } }), 400, "invalid_grant");
    const arr = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: key.kid })
      .setIssuer(tb.agent.clientId).setSubject(USER).setAudience([TOKEN_EP, "https://other.example/oauth/token"])
      .setIssuedAt().setExpirationTime("60s").setJti(rid()).sign(key.privateKey);
    expectError(await post({ form: { assertion: arr } }), 400, "invalid_grant");
  });

  test("a session assertion from another agent (iss mismatch)", async () => {
    const { post, tb } = await setup();
    const other = await tb.addAgent("other.example");
    const a = await sessionAssertion(other.clientId, USER, TOKEN_EP, other.identity.signingKey);
    expectError(await post({ form: { assertion: a } }), 400, "invalid_grant");
  });

  test("a missing session assertion", async () => {
    const { post } = await setup();
    expectError(await post({ form: { assertion: undefined } }), 400, "invalid_grant");
  });
});

describe("request shape and DPoP at the token endpoint (400)", () => {
  test("A-45: a missing DPoP proof is 400 invalid_dpop_proof", async () => {
    const { post } = await setup();
    expectError(await post({ proof: null }), 400, "invalid_dpop_proof");
  });

  test("A-45: a stale or wrong-URL proof is 400 invalid_dpop_proof", async () => {
    const { post, dpop } = await setup();
    expectError(await post({ proof: await dpopProof(dpop, "POST", TOKEN_EP, { iat: Math.floor(Date.now() / 1000) - 120 }) }),
      400, "invalid_dpop_proof");
    expectError(await post({ proof: await dpopProof(dpop, "POST", "https://tipping.example/oauth/other") }),
      400, "invalid_dpop_proof");
    expectError(await post({ proof: await dpopProof(dpop, "GET", TOKEN_EP) }), 400, "invalid_dpop_proof");
  });

  test("a replayed proof", async () => {
    const { post, dpop } = await setup();
    const p = await dpopProof(dpop, "POST", TOKEN_EP);
    expect((await post({ proof: p })).res.status).toBe(200);
    expectError(await post({ proof: p }), 400, "invalid_dpop_proof");
  });

  test("unsupported or missing grant_type", async () => {
    const { post } = await setup();
    expectError(await post({ form: { grant_type: "password" } }), 400, "unsupported_grant_type");
    expectError(await post({ form: { grant_type: undefined } }), 400, "unsupported_grant_type");
  });

  test("a JSON body, and duplicate parameters", async () => {
    const { post, tb } = await setup();
    expectError(await post({ contentType: "application/json" }), 400, "invalid_request");
    const res = await tb.fetch(TOKEN_EP, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=a&grant_type=b" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_request");
  });

  test("requireDpopNonce: use_dpop_nonce (400) with a DPoP-Nonce header, then success with it", async () => {
    const { post, dpop } = await setup({ company: { requireDpopNonce: true } });
    const first = await post();
    expectError(first, 400, "use_dpop_nonce");
    const nonce = first.res.headers.get("dpop-nonce")!;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const ok = await post({ proof: await dpopProof(dpop, "POST", TOKEN_EP, { nonce }) });
    expect(ok.res.status).toBe(200);
    expect(ok.res.headers.get("dpop-nonce")).toBe(nonce);
  });

  test("rate_limited (429) with Retry-After", async () => {
    const { post } = await setup({ tokenRateLimit: 1 });
    expect((await post()).res.status).toBe(200);
    const r = await post();
    expectError(r, 429, "rate_limited");
    expect(Number(r.res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("session renewal (S4 G1)", () => {
  test("the grant with session_id returns a new signed-out token for that Session", async () => {
    const { post } = await setup();
    const first = (await post()).json;
    const again = await post({ form: { session_id: first.session_id as string } });
    expect(again.res.status).toBe(200);
    expect(again.json).toMatchObject({ session_id: first.session_id, signed_in: false, scope: "" });
    expect(again.json.access_token).not.toBe(first.access_token);
  });

  test("invalid_session for an unknown or ended Session", async () => {
    const { post, tb } = await setup();
    expectError(await post({ form: { session_id: "ses_nope" } }), 400, "invalid_session");
    const first = (await post()).json;
    await edit(tb.company.stores.sessions, first.session_id as string, (x) => { x.ended = true; });
    expectError(await post({ form: { session_id: first.session_id as string } }), 400, "invalid_session");
  });

  test("A-04: invalid_session for another agent's or another user's Session", async () => {
    const { post, tb } = await setup();
    const first = (await post()).json;
    const other = await tb.addAgent("other.example");
    expectError(await post({ clientId: other.clientId, signingKey: other.identity.signingKey,
      form: { session_id: first.session_id as string } }), 400, "invalid_session");
    expectError(await post({ userId: "u_someoneelse00000", form: { session_id: first.session_id as string } }),
      400, "invalid_session");
  });
});

describe("dev flag", () => {
  test("http://localhost client_id works only with the flag", async () => {
    const off = await setup();
    off.tb.hosts["localhost:8788"] = off.tb.hosts["agent.example"]!;
    expectError(await off.post({ clientId: "http://localhost:8788/agent.json" }), 401, "invalid_client");

    const on = await setup({ company: { devAllowHttpLocalhost: true } });
    const local = await on.tb.addAgent("localhost:8788");
    // addAgent serves https:// URLs; serve an http:// one instead.
    const { createAgentHost } = await import("agent-host");
    on.tb.hosts["localhost:8788"] = createAgentHost({ baseUrl: "http://localhost:8788", clientName: "Dev",
      publicJwks: [local.keys.publicJwk] });
    const r = await on.post({ clientId: "http://localhost:8788/agent.json", signingKey: local.identity.signingKey });
    expect(r.res.status).toBe(200);
  });
});

test("PoppyError is what the agent sees for a token error", async () => {
  const { tb } = await setup({ tokenRateLimit: 0 });
  const e = await tb.client().startSession().catch((x: unknown) => x);
  expect(e).toBeInstanceOf(PoppyError);
  expect(e).toMatchObject({ code: "rate_limited", status: 429 });
  expect(tb.sleeps).toEqual([30_000]); // Retry-After is about 60 s, capped at 30 s
});
