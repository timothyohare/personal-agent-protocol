// Edge cases and exact error descriptions for the token, revocation, authorize and API code,
// so that every check is pinned down by a test (gate-mutation, SecurityReview section 7).
import { afterEach, describe, expect, test, vi } from "vitest";
import { MemoryVault } from "agent";
import { clientAssertion, dpopProof, newDpopKey, pkceChallenge, pkceVerifier, sessionAssertion } from "poppy-core";
import { CLIENT_ASSERTION_TYPE, GRANT_JWT_BEARER } from "../src/index.ts";
import { COMPANY, TOKEN_EP, testbed } from "../../../test-support/testbed.ts";
import { TestBrowser, parseForm, userSignsIn } from "../../../test-support/browser.ts";
import { signInFlow } from "../../../test-support/signin.ts";

afterEach(() => { vi.restoreAllMocks(); });

type Tb = Awaited<ReturnType<typeof testbed>>;

async function post(tb: Tb, url: string, form: Record<string, string | undefined>, o: {
  proof?: boolean; contentType?: string; env?: unknown; who?: Tb["agent"];
} = {}) {
  const who = o.who ?? tb.agent;
  const full: Record<string, string> = {
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: await clientAssertion(who.clientId, TOKEN_EP, who.identity.signingKey),
  };
  for (const [k, v] of Object.entries(form)) {
    if (v === undefined) delete full[k];
    else full[k] = v;
  }
  const req = new Request(url, { method: "POST", body: new URLSearchParams(full), headers: {
    "content-type": o.contentType ?? "application/x-www-form-urlencoded",
    ...(o.proof === false ? {} : { dpop: await dpopProof(await newDpopKey(), "POST", TOKEN_EP) }) } });
  const res = await tb.company.app.fetch(req, o.env as never);
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => ({})) as Record<string, string> };
}

const sessionGrant = async (tb: Tb, extra: Record<string, string> = {}) => ({
  grant_type: GRANT_JWT_BEARER,
  assertion: await sessionAssertion(tb.agent.clientId, "u_hardening0000000", TOKEN_EP, tb.agent.identity.signingKey),
  ...extra,
});

describe("token endpoint: exact errors", () => {
  test("client authentication failures carry their reason", async () => {
    const tb = await testbed();
    expect((await post(tb, TOKEN_EP, { ...await sessionGrant(tb), client_assertion: undefined })).json)
      .toEqual({ error: "invalid_client", error_description: "client assertion required" });
    expect((await post(tb, TOKEN_EP, { ...await sessionGrant(tb), client_assertion: "x.y.z" })).json)
      .toEqual({ error: "invalid_client", error_description: "malformed client assertion" });
    const noIss = `${Buffer.from('{"alg":"ES256"}').toString("base64url")}.${Buffer.from('{"sub":"x"}').toString("base64url")}.sig`;
    expect((await post(tb, TOKEN_EP, { ...await sessionGrant(tb), client_assertion: noIss })).json.error_description)
      .toBe("malformed client assertion");
    expect((await post(tb, TOKEN_EP, { ...await sessionGrant(tb), client_id: "https://x.example/agent.json" })).json)
      .toEqual({ error: "invalid_client", error_description: "client_id does not match the assertion" });
    const other = await tb.addAgent("other.example");
    const wrongKey = { ...tb.agent, identity: { ...tb.agent.identity, signingKey: { ...other.identity.signingKey,
      kid: tb.agent.identity.signingKey.kid } } };
    expect((await post(tb, TOKEN_EP, await sessionGrant(tb), { who: wrongKey })).json.error_description)
      .toMatch(/^client assertion: signature verification failed/);
  });

  test("a matching client_id parameter is accepted", async () => {
    const tb = await testbed();
    expect((await post(tb, TOKEN_EP, { ...await sessionGrant(tb), client_id: tb.agent.clientId })).status).toBe(200);
  });

  test("grant and request errors carry their reason", async () => {
    const tb = await testbed();
    expect((await post(tb, TOKEN_EP, { ...await sessionGrant(tb), assertion: "nope" })).json.error_description)
      .toMatch(/^session assertion: /);
    expect((await post(tb, TOKEN_EP, await sessionGrant(tb, { session_id: "ses_x" }))).json)
      .toEqual({ error: "invalid_session", error_description: "unknown session, or not yours" });
    expect((await post(tb, TOKEN_EP, { grant_type: undefined })).json)
      .toEqual({ error: "unsupported_grant_type", error_description: "grant_type (missing)" });
    expect((await post(tb, TOKEN_EP, { grant_type: "password" })).json.error_description).toBe("grant_type password");
    expect((await post(tb, TOKEN_EP, {}, { contentType: "text/application/x-www-form-urlencoded" })).json)
      .toEqual({ error: "invalid_request", error_description: "body must be application/x-www-form-urlencoded" });
    const dup = await tb.company.app.fetch(new Request(TOKEN_EP, { method: "POST", body: "a=1&a=2",
      headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect(await dup.json()).toEqual({ error: "invalid_request", error_description: "duplicate parameter a" });
  });

  test("rate limits are per client IP, and token and revoke share a bucket", async () => {
    const tb = await testbed({ tokenRateLimit: 1 });
    const ip = (a: string) => ({ incoming: { socket: { remoteAddress: a } } });
    expect((await post(tb, TOKEN_EP, await sessionGrant(tb), { env: ip("1.1.1.1") })).status).toBe(200);
    expect((await post(tb, TOKEN_EP, await sessionGrant(tb), { env: ip("2.2.2.2") })).status).toBe(200);
    const limited = await post(tb, TOKEN_EP, await sessionGrant(tb), { env: ip("1.1.1.1") });
    expect(limited.json).toEqual({ error: "rate_limited", error_description: "slow down" });
    const revoke = await post(tb, `${COMPANY}/oauth/revoke`, { token: "x" }, { env: ip("2.2.2.2"), proof: false });
    expect(revoke.status).toBe(429);
    expect(Number(revoke.headers.get("retry-after"))).toBeGreaterThan(0);
    // In-process requests without a socket share the "local" bucket.
    expect((await post(tb, TOKEN_EP, await sessionGrant(tb))).status).toBe(200);
    expect((await post(tb, TOKEN_EP, await sessionGrant(tb), { env: {} })).status).toBe(429);
  });
});

describe("code and refresh grants: exact errors and boundaries", () => {
  async function withCode() {
    const tb = await testbed();
    const s = await tb.client().startSession();
    const verifier = pkceVerifier();
    const u = new URL(`${COMPANY}/oauth/authorize`);
    u.search = new URLSearchParams({ response_type: "code", client_id: tb.agent.clientId,
      redirect_uri: "https://agent.example/oauth/callback", scope: "poppy:read", state: "s",
      code_challenge: pkceChallenge(verifier), code_challenge_method: "S256" }).toString();
    const code = new URL(await userSignsIn(new TestBrowser(tb.fetch), u.toString())).searchParams.get("code")!;
    const form = { grant_type: "authorization_code", code, code_verifier: verifier,
      redirect_uri: "https://agent.example/oauth/callback", session_id: s.sessionId };
    return { tb, form, code };
  }

  test("each code check has its own description", async () => {
    let { tb, form } = await withCode();
    expect((await post(tb, TOKEN_EP, { ...form, redirect_uri: "https://agent.example/x" })).json.error_description)
      .toBe("redirect_uri mismatch");
    ({ tb, form } = await withCode());
    expect((await post(tb, TOKEN_EP, { ...form, code_verifier: pkceVerifier() })).json.error_description)
      .toBe("PKCE verification failed");
    ({ tb, form } = await withCode());
    expect((await post(tb, TOKEN_EP, { ...form, session_id: undefined })).json)
      .toEqual({ error: "invalid_request", error_description: "session_id required" });
    expect((await post(tb, TOKEN_EP, form)).json.error_description).toBe("unknown, used or expired code");
    ({ tb, form } = await withCode());
    const other = await tb.addAgent("other.example");
    expect((await post(tb, TOKEN_EP, form, { who: other })).json.error_description).toBe("code was issued to another client");
  });

  test("a code expires exactly at its expiry time", async () => {
    const { tb, form, code } = await withCode();
    vi.spyOn(Date, "now").mockReturnValue(tb.company.stores.codes.get(code)!.expiresAt);
    expect((await post(tb, TOKEN_EP, form)).json.error).toBe("invalid_grant");
  });

  test("Account Tokens get an at_ id; refresh errors carry their reason; scope tolerates extra spaces", async () => {
    const tb = await testbed();
    const client = tb.client(new MemoryVault());
    await signInFlow(client, tb.fetch, { scopes: ["poppy:read", "standings"] });
    const at = (await client.accountToken())!.token;
    expect(tb.company.stores.accountTokens.get(at)!.id).toMatch(/^at_[A-Za-z0-9_-]{22}$/);
    const refresh = (extra: Record<string, string> = {}, who = tb.agent) =>
      post(tb, TOKEN_EP, { grant_type: "refresh_token", refresh_token: at, ...extra }, { who });
    expect((await refresh({ scope: "poppy:read  standings" })).json).toMatchObject({ scope: "poppy:read standings" });
    expect((await refresh({ scope: "poppy:write" })).json.error_description)
      .toBe("scope can only narrow the Account Token's scope");
    expect((await refresh({}, await tb.addAgent("thief.example"))).json.error_description)
      .toBe("Account Token was issued to another client");
    expect((await refresh({ refresh_token: "nope" })).json.error_description).toBe("unknown or revoked Account Token");
    // Refresh into an existing Session is narrated as such.
    await refresh({ session_id: client.session!.sessionId });
    expect(tb.logs.at(-1)).toMatch(/session\.refreshed .* new_session=false rotated=false$/);
  });

  test("account_mismatch has its reason", async () => {
    const tb = await testbed();
    const client = tb.client(new MemoryVault());
    await signInFlow(client, tb.fetch);
    const url = await client.beginSignIn(["poppy:read"]);
    const err = await client.completeSignIn(await userSignsIn(new TestBrowser(tb.fetch), url,
      { username: "rival", password: "battery staple horse correct" })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "account_mismatch", detail: "this Session is signed in to a different account" });
  });
});

describe("revocation details", () => {
  async function signedIn() {
    const tb = await testbed();
    const client = tb.client(new MemoryVault());
    const { session } = await signInFlow(client, tb.fetch);
    return { tb, client, session, at: (await client.accountToken())!.token };
  }
  const revokeUrl = `${COMPANY}/oauth/revoke`;

  test("a 200 is no-store; errors carry their reason", async () => {
    const { tb, at } = await signedIn();
    expect((await post(tb, revokeUrl, { token: undefined }, { proof: false })).json)
      .toEqual({ error: "invalid_request", error_description: "token required" });
    expect((await post(tb, revokeUrl, { token: at }, { proof: false, contentType: "text/plain" })).json.error_description)
      .toBe("body must be application/x-www-form-urlencoded");
    expect((await post(tb, revokeUrl, { token: at }, { proof: false, who: await tb.addAgent("o.example") })).json)
      .toEqual({ error: "invalid_request", error_description: "token was issued to another client" });
    const ok = await post(tb, revokeUrl, { token: at }, { proof: false });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  test("revoking one Account Token leaves Sessions signed in with another one alone", async () => {
    const one = await signedIn();
    const second = one.tb.client(new MemoryVault());
    const s2 = (await signInFlow(second, one.tb.fetch)).session;
    await post(one.tb, revokeUrl, { token: one.at }, { proof: false });
    expect(one.tb.company.stores.sessions.get(s2.sessionId)!.accountTokenId).not.toBeNull();
    expect((await second.call("GET", "/api/me/tips")).status).toBe(200);
  });

  test("another agent can't revoke our Session Token; an unknown one is ignored", async () => {
    const { tb, session } = await signedIn();
    const other = await tb.addAgent("o.example");
    expect((await post(tb, revokeUrl, { token: session.token }, { proof: false, who: other })).status).toBe(200);
    expect(tb.company.stores.tokens.has(session.token)).toBe(true);
    expect((await post(tb, revokeUrl, { token: "unknown" }, { proof: false })).status).toBe(200);
  });

  test("F11: a token from a revoked Account Token stays signed out after the user signs in again", async () => {
    const { tb, client, session, at } = await signedIn();
    await post(tb, revokeUrl, { token: at }, { proof: false });
    const again = (await signInFlow(client, tb.fetch)).session;
    expect(again.sessionId).toBe(session.sessionId);
    const { currentAuth } = await import("../src/index.ts");
    const old = tb.company.stores.tokens.get(session.token)!;
    expect(currentAuth(old, tb.company.stores.sessions.get(old.sessionId)!).signedIn).toBe(false);
    expect(currentAuth(tb.company.stores.tokens.get(again.token)!, tb.company.stores.sessions.get(again.sessionId)!).signedIn)
      .toBe(true);
  });
});

describe("API middleware details", () => {
  async function session(opts: Parameters<typeof testbed>[0] = {}) {
    const tb = await testbed(opts);
    const client = tb.client(new MemoryVault());
    const s = await client.startSession();
    const key = await client.dpopKey();
    const get = async (authorization: string | undefined, o: { iat?: number; nonce?: string } = {}) => {
      const res = await tb.fetch(`${COMPANY}/api/fixtures`, { headers: {
        ...(authorization ? { authorization } : {}),
        dpop: await dpopProof(key, "GET", `${COMPANY}/api/fixtures`, { accessToken: s.token, ...o }) } });
      return { status: res.status, headers: res.headers, json: await res.json() as Record<string, string> };
    };
    return { tb, client, s, get };
  }

  test("WWW-Authenticate has the exact DPoP form, and errors are no-store", async () => {
    const { get } = await session();
    const r = await get(undefined);
    expect(r.headers.get("www-authenticate"))
      .toBe('DPoP error="invalid_token", error_description="DPoP Session Token required in the Authorization header", algs="ES256"');
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.json).toEqual({ error: "invalid_token", error_description: "DPoP Session Token required in the Authorization header" });
  });

  test("quotes in an error description are stripped from the header", async () => {
    const { get, s } = await session();
    const r = await get(`DPoP ${s.token}`, { iat: Math.floor(Date.now() / 1000) - 120 });
    const www = r.headers.get("www-authenticate")!;
    expect(r.json.error_description).toContain('"iat"');
    expect(www).toMatch(/error_description="invalid_dpop_proof: iat claim timestamp check failed[^"]*", algs="ES256"$/);
  });

  test("the scheme is case-insensitive and tolerates extra spaces, but must be the whole header", async () => {
    const { get, s } = await session();
    expect((await get(`dpop ${s.token}`)).status).toBe(200);
    expect((await get(`DPoP   ${s.token}`)).status).toBe(200);
    expect((await get(`xDPoP ${s.token}`)).json.error).toBe("invalid_token");
    expect((await get(`DPoP ${s.token} extra`)).json.error).toBe("invalid_token");
  });

  test("a token expires exactly at its expiry time, with its reason", async () => {
    const { get, s, tb } = await session();
    vi.spyOn(Date, "now").mockReturnValue(tb.company.stores.tokens.get(s.token)!.expiresAt);
    expect((await get(`DPoP ${s.token}`)).json).toEqual({ error: "invalid_token", error_description: "unknown, expired or ended token" });
  });

  test("sign_in_required and insufficient_scope have their reasons", async () => {
    const tb = await testbed();
    const c = tb.client(new MemoryVault());
    expect((await c.call("GET", "/api/me/tips")).body).toEqual({ error: "sign_in_required",
      error_description: "sign in to use this API", scope: "poppy:read" });
    await signInFlow(c, tb.fetch, { scopes: ["poppy:read"] });
    expect((await c.call("GET", "/api/me/score")).body).toEqual({ error: "insufficient_scope",
      error_description: "this API needs the standings scope", scope: "standings" });
  });

  test("with nonces on, a successful response carries the current DPoP-Nonce", async () => {
    const { client, tb } = await session({ company: { requireDpopNonce: true } });
    let nonce: string | null = null;
    const real = tb.hosts["tipping.example"]!;
    tb.hosts["tipping.example"] = { fetch: async (r) => {
      const res = await real.fetch(r);
      if (r.url.endsWith("/api/ladder") && res.status === 200) nonce = res.headers.get("dpop-nonce");
      return res;
    } };
    expect((await client.call("GET", "/api/ladder")).status).toBe(200);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("authorize details", () => {
  const authz = (tb: Tb, over: Record<string, string | undefined> = {}) => {
    const u = new URL(`${COMPANY}/oauth/authorize`);
    const p: Record<string, string | undefined> = { response_type: "code", client_id: tb.agent.clientId,
      redirect_uri: "https://agent.example/oauth/callback", scope: "poppy:read poppy:write", state: "s",
      code_challenge: pkceChallenge(pkceVerifier()), code_challenge_method: "S256", ...over };
    for (const [k, v] of Object.entries(p)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  };
  const text = async (r: Response) => r.text();

  test("each refusal page says why", async () => {
    const tb = await testbed();
    const b = new TestBrowser(tb.fetch);
    expect(await text(await b.get(authz(tb, { client_id: undefined })))).toContain("Missing client_id.");
    expect(await text(await b.get(authz(tb, { client_id: "https://nobody.example/agent.json" }))))
      .toContain("This agent couldn&#39;t be verified.");
    expect(await text(await b.get(authz(tb, { redirect_uri: "https://evil.example/cb" }))))
      .toContain("The redirect URI isn&#39;t registered for this agent.");
    expect(await text(await b.get(authz(tb, { code_challenge_method: "plain" })))).toContain("PKCE with S256 is required.");
  });

  test("the code_challenge must be exactly 43 base64url characters", async () => {
    const tb = await testbed();
    const b = new TestBrowser(tb.fetch);
    const good = pkceChallenge(pkceVerifier());
    for (const bad of [`${good}A`, `!!${good}`, `${good}!!`, good.slice(1)]) {
      expect((await b.get(authz(tb, { code_challenge: bad }))).status).toBe(400);
    }
    expect((await b.get(authz(tb, { code_challenge: good }))).status).toBe(200);
  });

  test("scope tolerates extra spaces and duplicates", async () => {
    const tb = await testbed();
    const r = await new TestBrowser(tb.fetch).get(authz(tb, { scope: " poppy:read  poppy:read standings " }));
    expect(r.status).toBe(200);
    expect(tb.company.stores.pending.values().next().value!.scope).toEqual(["poppy:read", "standings"]);
  });

  test("pages send no-referrer and nosniff; the cookie is HttpOnly, Lax, /oauth and Secure over https", async () => {
    const tb = await testbed();
    const r = await new TestBrowser(tb.fetch).get(authz(tb));
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^poppy_authz=[A-Za-z0-9_-]{22};/);
    for (const attr of ["HttpOnly", "SameSite=Lax", "Path=/oauth", "Secure"]) expect(cookie).toContain(attr);
    // An http issuer (local dev) can't set a Secure cookie.
    const dev = await testbed({ company: { baseUrl: "http://tipping.example", devAllowHttpLocalhost: true } });
    const dr = await new TestBrowser(dev.fetch).get(authz(dev).replace("https://tipping", "http://tipping"));
    expect(dr.status).toBe(200);
    expect(dr.headers.get("set-cookie")).toMatch(/^poppy_authz=.*HttpOnly/);
    expect(dr.headers.get("set-cookie")).not.toContain("Secure");
  });

  test("an unknown or expired sign-in request says so, at login and at consent", async () => {
    const tb = await testbed();
    const b = new TestBrowser(tb.fetch);
    const f = parseForm(await (await b.get(authz(tb))).text());
    const fields = (req: string): [string, string][] => [["req", req], ["csrf", f.hidden.csrf!], ["username", "tipper"],
      ["password", "correct horse battery staple"]];
    for (const path of ["login", "consent"]) {
      const r = await b.post(`${COMPANY}/oauth/authorize/${path}`, fields("unknown"));
      expect(r.status).toBe(400);
      expect(await r.text()).toContain("This sign-in request has expired.");
    }
    vi.spyOn(Date, "now").mockReturnValue(tb.company.stores.pending.get(f.hidden.req!)!.expiresAt);
    const expired = await b.post(`${COMPANY}/oauth/authorize/login`, fields(f.hidden.req!));
    expect(await expired.text()).toContain("This sign-in request has expired.");
  });

  test("CSRF failures and consent-before-login say why; a duplicated csrf field is refused", async () => {
    const tb = await testbed();
    const b = new TestBrowser(tb.fetch);
    const f = parseForm(await (await b.get(authz(tb))).text());
    const csrfFail = await b.post(`${COMPANY}/oauth/authorize/login`, [["req", f.hidden.req!], ["csrf", "x"]]);
    expect(await csrfFail.text()).toContain("The form is invalid (CSRF check failed).");
    const consentFail = await b.post(`${COMPANY}/oauth/authorize/consent`, [["req", f.hidden.req!], ["csrf", "x"]]);
    expect(await consentFail.text()).toContain("The form is invalid (CSRF check failed).");
    const early = await b.post(`${COMPANY}/oauth/authorize/consent`, [["req", f.hidden.req!], ["csrf", f.hidden.csrf!]]);
    expect(await early.text()).toContain("Sign in first.");
    const dup = await b.post(`${COMPANY}/oauth/authorize/login`, [["req", f.hidden.req!], ["csrf", f.hidden.csrf!],
      ["csrf", "x"], ["username", "tipper"], ["password", "correct horse battery staple"]]);
    expect(dup.status).toBe(403);
  });

  test("the consent page describes each standard scope", async () => {
    const tb = await testbed();
    const b = new TestBrowser(tb.fetch);
    const f = parseForm(await (await b.get(authz(tb))).text());
    const html = await (await b.post(`${COMPANY}/oauth/authorize/login`, [["req", f.hidden.req!], ["csrf", f.hidden.csrf!],
      ["username", "tipper"], ["password", "correct horse battery staple"]])).text();
    expect(html).toContain("See your tips");
    expect(html).toContain("Submit and change tips for you");
  });

  test("the login rate limit is per sign-in request and says so", async () => {
    const tb = await testbed({ loginRateLimit: 1 });
    const b = new TestBrowser(tb.fetch);
    const login = async () => {
      const f = parseForm(await (await b.get(authz(tb))).text());
      const go = () => b.post(`${COMPANY}/oauth/authorize/login`, [["req", f.hidden.req!], ["csrf", f.hidden.csrf!],
        ["username", "tipper"], ["password", "nope"]]);
      await go();
      return (await go()).text();
    };
    expect(await login()).toContain("Too many attempts. Wait a minute and try again.");
    // A new sign-in request starts a new count.
    const f2 = parseForm(await (await b.get(authz(tb))).text());
    expect(await (await b.post(`${COMPANY}/oauth/authorize/login`, [["req", f2.hidden.req!], ["csrf", f2.hidden.csrf!],
      ["username", "tipper"], ["password", "nope"]])).text()).toContain("Wrong username or password.");
  });
});
