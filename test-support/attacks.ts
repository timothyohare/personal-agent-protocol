// The attack suite (SecurityReview section 5, Task 11). Each attack is defined once and runs either
// in-process (packages/company/test/attacks.test.ts) or against the booted services (scripts/attacks.ts).
// Every attack must fail closed with the exact status and error code in the review.
import { SignJWT } from "jose";
import { CompanyClient, MemoryVault, redirectUriFor, type AgentIdentity, type Vault } from "agent";
import {
  clientAssertion, dpopProof, newDpopKey, pkceChallenge, pkceVerifier, rid, sessionAssertion, type DpopKey,
} from "poppy-core";
import { TestBrowser, parseForm, userSignsIn, type SignInOptions } from "./browser.ts";

export interface AgentRef {
  clientId: string;
  identity: AgentIdentity;
}

export interface Served {
  origin: string;
  hits: () => number;
  close: () => void;
}

export interface AttackContext {
  fetch: typeof fetch;
  /** What the agent is asked to discover, e.g. "tipping.example" or "localhost:8787". */
  company: string;
  /** The company origin, e.g. "https://tipping.example". */
  base: string;
  allowHttpLocalhost: boolean;
  agent: AgentRef;
  /** A second, registered agent that tries to use the first agent's things. */
  attacker: AgentRef;
  /** Serves JSON documents (by path) at a fresh origin the company is allowed to fetch. */
  serveDocs: (docs: (origin: string) => Record<string, unknown>) => Promise<Served>;
  /** An origin at an internal (loopback) address. `hits` counts requests that reached it. */
  internalTarget: () => Promise<Served & { clientId: string }>;
  /** The second test account (A-43). */
  secondUser: { username: string; password: string };
}

export interface Outcome {
  pass: boolean;
  observed: string;
}

export interface Attack {
  id: string;
  title: string;
  expected: string;
  run: (ctx: AttackContext) => Promise<Outcome>;
}

// ---------- helpers ----------

const tokenEp = (ctx: AttackContext) => `${ctx.base}/oauth/token`;

function client(ctx: AttackContext, who: AgentRef = ctx.agent, vault: Vault = new MemoryVault()) {
  return new CompanyClient(ctx.company, { identity: who.identity, vault, fetch: ctx.fetch,
    allowHttpLocalhost: ctx.allowHttpLocalhost, sleep: async () => {} });
}

async function signIn(ctx: AttackContext, c: CompanyClient, scopes: string[], o: SignInOptions = {}) {
  const url = await c.beginSignIn(scopes);
  return c.completeSignIn(await userSignsIn(new TestBrowser(ctx.fetch), url, o));
}

interface Raw {
  status: number;
  error: string | undefined;
  www: string | null;
  location: string | null;
  json: Record<string, unknown>;
}

async function raw(res: Response): Promise<Raw> {
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, error: typeof json.error === "string" ? json.error : undefined,
    www: res.headers.get("www-authenticate"), location: res.headers.get("location"), json };
}

/** A raw token-endpoint POST. `proof: null` sends no DPoP header. */
async function tokenPost(ctx: AttackContext, form: Record<string, string>,
  o: { who?: AgentRef; proof?: string | null; key?: DpopKey } = {}): Promise<Raw> {
  const who = o.who ?? ctx.agent;
  const body = new URLSearchParams({
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: await clientAssertion(who.clientId, tokenEp(ctx), who.identity.signingKey),
    ...form,
  });
  const proof = o.proof === null ? undefined : o.proof ?? await dpopProof(o.key ?? await newDpopKey(), "POST", tokenEp(ctx));
  return raw(await ctx.fetch(tokenEp(ctx), { method: "POST", body,
    headers: { "content-type": "application/x-www-form-urlencoded", ...(proof ? { dpop: proof } : {}) } }));
}

async function sessionStart(ctx: AttackContext, key: DpopKey, userId = `u_${rid()}`) {
  return tokenPost(ctx, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: await sessionAssertion(ctx.agent.clientId, userId, tokenEp(ctx), ctx.agent.identity.signingKey) }, { key });
}

/** A signed-out Session Token and the key it's bound to. */
async function sessionToken(ctx: AttackContext) {
  const key = await newDpopKey();
  const r = await sessionStart(ctx, key);
  return { key, token: r.json.access_token as string };
}

async function apiGet(ctx: AttackContext, path: string, token: string | undefined, proof: string | undefined): Promise<Raw> {
  return raw(await ctx.fetch(`${ctx.base}${path}`, { headers: {
    ...(token ? { authorization: `DPoP ${token}` } : {}), ...(proof ? { dpop: proof } : {}) } }));
}

const FIX = "/api/fixtures";

function authorizeUrl(ctx: AttackContext, over: Record<string, string | undefined> = {}, who: AgentRef = ctx.agent) {
  const u = new URL(`${ctx.base}/oauth/authorize`);
  const params: Record<string, string | undefined> = {
    response_type: "code", client_id: who.clientId, redirect_uri: redirectUriFor(who.clientId), scope: "poppy:read",
    state: rid(), code_challenge: pkceChallenge(pkceVerifier()), code_challenge_method: "S256", ...over,
  };
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** A fresh authorization code for `who`, with its verifier. */
async function newCode(ctx: AttackContext, who: AgentRef = ctx.agent, scope = "poppy:read") {
  const verifier = pkceVerifier();
  const loc = await userSignsIn(new TestBrowser(ctx.fetch),
    authorizeUrl(ctx, { scope, code_challenge: pkceChallenge(verifier) }, who));
  return { code: new URL(loc).searchParams.get("code")!, verifier, redirectUri: redirectUriFor(who.clientId) };
}

const is = (r: Raw, status: number, error?: string) => r.status === status && (error === undefined || r.error === error);
const show = (r: Raw) => `${r.status}${r.error ? ` ${r.error}` : ""}`;
const outcome = (pass: boolean, observed: string): Outcome => ({ pass, observed });
const all = (rs: Raw[], status: number, error?: string) => outcome(rs.every((r) => is(r, status, error)), rs.map(show).join(", "));
const dpopWww = (r: Raw) => r.www?.startsWith("DPoP ") ?? false;

/** Counts token-endpoint POSTs made through a wrapped fetch. */
function countingFetch(ctx: AttackContext) {
  let n = 0;
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/oauth/token") && (init?.method ?? (input instanceof Request ? input.method : "GET")) === "POST") n++;
    return ctx.fetch(input, init);
  }) as typeof fetch;
  return { fetch: f, count: () => n };
}

/** The agent aborts sign-in on a tampered callback, and sends nothing to the token endpoint. */
async function tamperedCallback(ctx: AttackContext, tamper: (u: URL) => void, code: string): Promise<Outcome> {
  const counter = countingFetch(ctx);
  const c = client({ ...ctx, fetch: counter.fetch });
  const url = await c.beginSignIn(["poppy:read"]);
  const cb = new URL(await userSignsIn(new TestBrowser(ctx.fetch), url));
  tamper(cb);
  const before = counter.count();
  const err = await c.completeSignIn(cb.toString()).then(() => "accepted", (e: { code?: string }) => e.code ?? "error");
  const sent = counter.count() - before;
  return outcome(err === code && sent === 0, `agent: ${err}; token requests sent: ${sent}`);
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

// ---------- the attacks ----------

export const ATTACKS: Attack[] = [
  { id: "A-01", title: "Replay an already-used DPoP proof", expected: "401 invalid_dpop_proof",
    run: async (ctx) => {
      const { key, token } = await sessionToken(ctx);
      const proof = await dpopProof(key, "GET", `${ctx.base}${FIX}`, { accessToken: token });
      const first = await apiGet(ctx, FIX, token, proof);
      const second = await apiGet(ctx, FIX, token, proof);
      return outcome(first.status === 200 && is(second, 401, "invalid_dpop_proof"), `first ${show(first)}, replay ${show(second)}`);
    } },

  { id: "A-02", title: "Send the token with no DPoP header", expected: "401 invalid_dpop_proof, WWW-Authenticate: DPoP",
    run: async (ctx) => {
      const { token } = await sessionToken(ctx);
      const r = await apiGet(ctx, FIX, token, undefined);
      return outcome(is(r, 401, "invalid_dpop_proof") && dpopWww(r), `${show(r)}, www=${r.www?.split(" ")[0]}`);
    } },

  { id: "A-03", title: "Send the token with a proof from a different key", expected: "401 invalid_dpop_proof",
    run: async (ctx) => {
      const { token } = await sessionToken(ctx);
      const r = await apiGet(ctx, FIX, token, await dpopProof(await newDpopKey(), "GET", `${ctx.base}${FIX}`, { accessToken: token }));
      return outcome(is(r, 401, "invalid_dpop_proof"), show(r));
    } },

  { id: "A-04", title: "Exchange a code, or refresh, using another agent's session_id", expected: "400 invalid_session",
    run: async (ctx) => {
      const victim = await client(ctx).startSession();
      const { code, verifier, redirectUri } = await newCode(ctx, ctx.attacker);
      const exchange = await tokenPost(ctx, { grant_type: "authorization_code", code, code_verifier: verifier,
        redirect_uri: redirectUri, session_id: victim.sessionId }, { who: ctx.attacker });
      const mallory = client(ctx, ctx.attacker);
      await signIn(ctx, mallory, ["poppy:read"]);
      const refresh = await tokenPost(ctx, { grant_type: "refresh_token", refresh_token: (await mallory.accountToken())!.token,
        session_id: victim.sessionId }, { who: ctx.attacker });
      return all([exchange, refresh], 400, "invalid_session");
    } },

  { id: "A-05", title: "Callback with a mismatched iss", expected: "agent aborts, no token request",
    run: (ctx) => tamperedCallback(ctx, (u) => u.searchParams.set("iss", "https://evil.example"), "iss_mismatch") },

  { id: "A-06", title: "Proof with the wrong htm or htu", expected: "401 invalid_dpop_proof",
    run: async (ctx) => {
      const { key, token } = await sessionToken(ctx);
      return all([
        await apiGet(ctx, FIX, token, await dpopProof(key, "POST", `${ctx.base}${FIX}`, { accessToken: token })),
        await apiGet(ctx, FIX, token, await dpopProof(key, "GET", `${ctx.base}/api/ladder`, { accessToken: token })),
        await apiGet(ctx, FIX, token, await dpopProof(key, "GET", `https://evil.example${FIX}`, { accessToken: token })),
      ], 401, "invalid_dpop_proof");
    } },

  { id: "A-07", title: "Proof with iat 120 s old, or 60 s in the future", expected: "401 invalid_dpop_proof",
    run: async (ctx) => {
      const { key, token } = await sessionToken(ctx);
      const now = Math.floor(Date.now() / 1000);
      const rs: Raw[] = [];
      for (const iat of [now - 120, now + 60]) {
        rs.push(await apiGet(ctx, FIX, token, await dpopProof(key, "GET", `${ctx.base}${FIX}`, { accessToken: token, iat })));
      }
      return all(rs, 401, "invalid_dpop_proof");
    } },

  { id: "A-08", title: "Use the session after Account Token revocation", expected: "403 sign_in_required; refresh 400 invalid_grant",
    run: async (ctx) => {
      const c = client(ctx);
      const s = await signIn(ctx, c, ["poppy:read"]);
      const at = (await c.accountToken())!.token;
      const key = await c.dpopKey();
      const revoke = await raw(await ctx.fetch(`${ctx.base}/oauth/revoke`, { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: at, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: await clientAssertion(ctx.agent.clientId, tokenEp(ctx), ctx.agent.identity.signingKey) }) }));
      const api = await apiGet(ctx, "/api/me/tips", s.token,
        await dpopProof(key, "GET", `${ctx.base}/api/me/tips`, { accessToken: s.token }));
      const refresh = await tokenPost(ctx, { grant_type: "refresh_token", refresh_token: at });
      return outcome(revoke.status === 200 && is(api, 403, "sign_in_required") && is(refresh, 400, "invalid_grant"),
        `revoke ${revoke.status}, api ${show(api)}, refresh ${show(refresh)}`);
    } },

  { id: "A-09", title: "Client assertion signed with a key not in jwks.json", expected: "401 invalid_client",
    run: async (ctx) => {
      const forged: AgentRef = { clientId: ctx.agent.clientId, identity: { clientId: ctx.agent.clientId,
        signingKey: { privateKey: ctx.attacker.identity.signingKey.privateKey, kid: ctx.agent.identity.signingKey.kid } } };
      const r = await tokenPost(ctx, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: await sessionAssertion(ctx.agent.clientId, `u_${rid()}`, tokenEp(ctx), ctx.agent.identity.signingKey) },
      { who: forged });
      return outcome(is(r, 401, "invalid_client"), show(r));
    } },

  { id: "A-10", title: "Reuse a session assertion jti", expected: "400 invalid_grant",
    run: async (ctx) => {
      const assertion = await sessionAssertion(ctx.agent.clientId, `u_${rid()}`, tokenEp(ctx), ctx.agent.identity.signingKey);
      const grant = "urn:ietf:params:oauth:grant-type:jwt-bearer";
      const first = await tokenPost(ctx, { grant_type: grant, assertion });
      const second = await tokenPost(ctx, { grant_type: grant, assertion });
      return outcome(first.status === 200 && is(second, 400, "invalid_grant"), `first ${show(first)}, reuse ${show(second)}`);
    } },

  { id: "A-11", title: "Session assertion with aud of another company, or an array", expected: "400 invalid_grant",
    run: async (ctx) => {
      const k = ctx.agent.identity.signingKey;
      const grant = "urn:ietf:params:oauth:grant-type:jwt-bearer";
      const other = await sessionAssertion(ctx.agent.clientId, `u_${rid()}`, "https://other.example/oauth/token", k);
      const array = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: k.kid }).setIssuer(ctx.agent.clientId)
        .setSubject(`u_${rid()}`).setAudience([tokenEp(ctx), "https://other.example/oauth/token"]).setIssuedAt()
        .setExpirationTime("60s").setJti(rid()).sign(k.privateKey);
      return all([await tokenPost(ctx, { grant_type: grant, assertion: other }),
        await tokenPost(ctx, { grant_type: grant, assertion: array })], 400, "invalid_grant");
    } },

  { id: "A-12", title: "Reuse an authorization code", expected: "400 invalid_grant; the first sign-in stays valid",
    run: async (ctx) => {
      const s = await client(ctx).startSession();
      const { code, verifier, redirectUri } = await newCode(ctx);
      const form = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri,
        session_id: s.sessionId };
      const first = await tokenPost(ctx, form);
      const second = await tokenPost(ctx, form);
      return outcome(first.status === 200 && is(second, 400, "invalid_grant"), `first ${show(first)}, reuse ${show(second)}`);
    } },

  { id: "A-13", title: "Wrong PKCE verifier", expected: "400 invalid_grant",
    run: async (ctx) => {
      const s = await client(ctx).startSession();
      const { code, redirectUri } = await newCode(ctx);
      const r = await tokenPost(ctx, { grant_type: "authorization_code", code, code_verifier: pkceVerifier(),
        redirect_uri: redirectUri, session_id: s.sessionId });
      return outcome(is(r, 400, "invalid_grant"), show(r));
    } },

  { id: "A-14", title: "code_challenge_method=plain or missing", expected: "error page, no redirect",
    run: async (ctx) => {
      const b = new TestBrowser(ctx.fetch);
      const rs = [await b.get(authorizeUrl(ctx, { code_challenge_method: "plain" })),
        await b.get(authorizeUrl(ctx, { code_challenge_method: undefined })),
        await b.get(authorizeUrl(ctx, { code_challenge: undefined }))];
      return outcome(rs.every((r) => r.status === 400 && !r.headers.get("location")),
        rs.map((r) => `${r.status}${r.headers.get("location") ? " redirect" : ""}`).join(", "));
    } },

  { id: "A-15", title: "Callback with the wrong state", expected: "agent aborts",
    run: (ctx) => tamperedCallback(ctx, (u) => u.searchParams.set("state", "forged-state"), "state_mismatch") },

  { id: "A-16", title: "redirect_uri not in the metadata (including prefix/suffix variants)", expected: "error page, no redirect",
    run: async (ctx) => {
      const b = new TestBrowser(ctx.fetch);
      const cb = redirectUriFor(ctx.agent.clientId);
      const rs: Response[] = [];
      for (const r of ["https://evil.example/cb", `${cb}/x`, `${cb}x`, cb.slice(0, -1), `${cb}?a=1`,
        redirectUriFor(ctx.attacker.clientId)]) {
        rs.push(await b.get(authorizeUrl(ctx, { redirect_uri: r })));
      }
      return outcome(rs.every((r) => r.status === 400 && !r.headers.get("location")),
        rs.map((r) => `${r.status}${r.headers.get("location") ? " redirect" : ""}`).join(", "));
    } },

  { id: "A-17", title: "POST consent without, or with the wrong, CSRF token", expected: "403",
    run: async (ctx) => {
      const b = new TestBrowser(ctx.fetch);
      const login = parseForm(await (await b.get(authorizeUrl(ctx))).text());
      await b.post(`${ctx.base}/oauth/authorize/login`, [["req", login.hidden.req!], ["csrf", login.hidden.csrf!],
        ["username", "tipper"], ["password", "correct horse battery staple"]]);
      const statuses: number[] = [];
      for (const csrf of ["", "wrong"]) {
        statuses.push((await b.post(`${ctx.base}/oauth/authorize/consent`, [["req", login.hidden.req!], ["csrf", csrf],
          ["scope", "poppy:read"], ["decision", "approve"]])).status);
      }
      // The right token from a different browser (no cookie) is also refused.
      statuses.push((await new TestBrowser(ctx.fetch).post(`${ctx.base}/oauth/authorize/consent`, [["req", login.hidden.req!],
        ["csrf", login.hidden.csrf!], ["scope", "poppy:read"], ["decision", "approve"]])).status);
      return outcome(statuses.every((s) => s === 403), statuses.join(", "));
    } },

  { id: "A-18", title: "client_id at an internal address", expected: "401 invalid_client, no request made",
    run: async (ctx) => {
      const target = await ctx.internalTarget();
      try {
        const as = (clientId: string) => tokenPost(ctx, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: "x", client_id: clientId }, { who: { clientId, identity: { ...ctx.agent.identity, clientId } } });
        const rs = [await as(target.clientId), await as("https://169.254.169.254/agent.json"),
          await as("http://169.254.169.254/agent.json"), await as("https://10.0.0.1/agent.json")];
        return outcome(rs.every((r) => is(r, 401, "invalid_client")) && target.hits() === 0,
          `${rs.map(show).join(", ")}; requests reaching the internal host: ${target.hits()}`);
      } finally {
        target.close();
      }
    } },

  { id: "A-19", title: "jwks_uri on a different host from client_id", expected: "401 invalid_client",
    run: async (ctx) => {
      const jwks = await ctx.serveDocs(() => ({ "/jwks.json": { keys: [] } }));
      const site = await ctx.serveDocs((origin) => ({ "/agent.json": { client_id: `${origin}/agent.json`,
        jwks_uri: `${jwks.origin}/jwks.json`, redirect_uris: [`${origin}/oauth/callback`],
        token_endpoint_auth_method: "private_key_jwt" } }));
      try {
        const clientId = `${site.origin}/agent.json`;
        const r = await tokenPost(ctx, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: "x" },
          { who: { clientId, identity: { ...ctx.agent.identity, clientId } } });
        return outcome(is(r, 401, "invalid_client") && site.hits() === 1 && jwks.hits() === 0,
          `${show(r)}; metadata fetched ${site.hits()}, jwks fetched ${jwks.hits()}`);
      } finally {
        site.close();
        jwks.close();
      }
    } },

  { id: "A-20", title: "Refresh with an Account Token from a different client_id", expected: "400 invalid_grant",
    run: async (ctx) => {
      const c = client(ctx);
      await signIn(ctx, c, ["poppy:read"]);
      const at = (await c.accountToken())!.token;
      const stolen = await tokenPost(ctx, { grant_type: "refresh_token", refresh_token: at }, { who: ctx.attacker });
      // Positive case: the same agent with a brand-new DPoP key is fine (spec 4.3).
      const own = await tokenPost(ctx, { grant_type: "refresh_token", refresh_token: at }, { key: await newDpopKey() });
      return outcome(is(stolen, 400, "invalid_grant") && own.status === 200, `stolen ${show(stolen)}, own+new key ${show(own)}`);
    } },

  { id: "A-23", title: "Use a scope the user unticked", expected: "granted scope excludes it; 403 insufficient_scope",
    run: async (ctx) => {
      const c = client(ctx);
      const s = await signIn(ctx, c, ["poppy:read", "poppy:write"], { untick: ["poppy:write"] });
      const r = await c.call("POST", "/api/me/tips", { fixture_id: "r27-1", team: "Storm" });
      return outcome(!s.scope.includes("poppy:write") && r.status === 403 && r.error === "insufficient_scope"
        && r.requiredScope === "poppy:write", `granted "${s.scope.join(" ")}", POST ${r.status} ${r.error} scope=${r.requiredScope}`);
    } },

  { id: "A-24", title: "DPoP proof with alg none, HS256, or a private jwk", expected: "401 invalid_dpop_proof",
    run: async (ctx) => {
      const { key, token } = await sessionToken(ctx);
      const { exportJWK } = await import("jose");
      const url = `${ctx.base}${FIX}`;
      const now = Math.floor(Date.now() / 1000);
      const none = `${b64({ typ: "dpop+jwt", alg: "none", jwk: key.publicJwk })}.${b64({ htm: "GET", htu: url, jti: rid(), iat: now })}.`;
      const hs = await new SignJWT({ htm: "GET", htu: url, jti: rid() })
        .setProtectedHeader({ typ: "dpop+jwt", alg: "HS256", jwk: { kty: "oct", k: "c2VjcmV0" } as never })
        .setIssuedAt().sign(new TextEncoder().encode("secret"));
      const priv = await dpopProof(key, "GET", url, { accessToken: token, headerJwk: await exportJWK(key.privateKey) });
      return all([await apiGet(ctx, FIX, token, none), await apiGet(ctx, FIX, token, hs), await apiGet(ctx, FIX, token, priv)],
        401, "invalid_dpop_proof");
    } },

  { id: "A-40", title: "20 parallel requests with the same jti, or the same code", expected: "exactly one success each",
    run: async (ctx) => {
      const { key, token } = await sessionToken(ctx);
      const proof = await dpopProof(key, "GET", `${ctx.base}${FIX}`, { accessToken: token });
      const jti = await Promise.all(Array.from({ length: 20 }, () => apiGet(ctx, FIX, token, proof)));
      const s = await client(ctx).startSession();
      const { code, verifier, redirectUri } = await newCode(ctx);
      const codes = await Promise.all(Array.from({ length: 20 }, () => tokenPost(ctx, { grant_type: "authorization_code",
        code, code_verifier: verifier, redirect_uri: redirectUri, session_id: s.sessionId })));
      const ok = (rs: Raw[]) => rs.filter((r) => r.status === 200).length;
      return outcome(ok(jti) === 1 && ok(codes) === 1, `same jti: ${ok(jti)} success; same code: ${ok(codes)} success`);
    } },

  { id: "A-42", title: "Send the Session Token as ?access_token= in the URL", expected: "401 invalid_token",
    run: async (ctx) => {
      const { key, token } = await sessionToken(ctx);
      const path = `${FIX}?access_token=${token}`;
      const r = await apiGet(ctx, path, undefined, await dpopProof(key, "GET", `${ctx.base}${path}`, { accessToken: token }));
      return outcome(is(r, 401, "invalid_token"), show(r));
    } },

  { id: "A-43", title: "Refresh into a Session signed in to a different account", expected: "400 account_mismatch",
    run: async (ctx) => {
      const vault = new MemoryVault();
      const c = client(ctx, ctx.agent, vault);
      await signIn(ctx, c, ["poppy:read"]);
      const firstAt = (await c.accountToken())!.token;
      const s2 = await c.startSession();
      await signIn(ctx, c, ["poppy:read"], ctx.secondUser);
      const r = await tokenPost(ctx, { grant_type: "refresh_token", refresh_token: firstAt, session_id: s2.sessionId });
      return outcome(is(r, 400, "account_mismatch"), show(r));
    } },

  { id: "A-44", title: "Authorize with a missing, unknown or unavailable scope", expected: "invalid_scope redirect to a valid redirect_uri",
    run: async (ctx) => {
      const b = new TestBrowser(ctx.fetch);
      const cb = redirectUriFor(ctx.agent.clientId);
      const results: string[] = [];
      let pass = true;
      for (const scope of [undefined, "admin", "poppy:read favourites"]) {
        const r = await b.get(authorizeUrl(ctx, { scope }));
        const loc = r.headers.get("location");
        const p = loc ? new URL(loc) : undefined;
        const good = r.status === 303 && !!p && `${p.origin}${p.pathname}` === cb && p.searchParams.get("error") === "invalid_scope"
          && p.searchParams.get("iss") === ctx.base;
        pass &&= good;
        results.push(`${r.status} ${p?.searchParams.get("error") ?? "-"}`);
      }
      return outcome(pass, results.join(", "));
    } },

  { id: "A-45", title: "Token request with an invalid or stale DPoP proof", expected: "400 invalid_dpop_proof",
    run: async (ctx) => {
      const key = await newDpopKey();
      const grant = { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer" };
      const withProof = async (proof: string | null) => tokenPost(ctx, { ...grant,
        assertion: await sessionAssertion(ctx.agent.clientId, `u_${rid()}`, tokenEp(ctx), ctx.agent.identity.signingKey) }, { proof });
      return all([await withProof(null),
        await withProof(await dpopProof(key, "POST", tokenEp(ctx), { iat: Math.floor(Date.now() / 1000) - 120 })),
        await withProof(await dpopProof(key, "GET", tokenEp(ctx)))], 400, "invalid_dpop_proof");
    } },

  { id: "A-46", title: "Revoke an Account Token using another agent's client assertion", expected: "refused; the token stays valid",
    run: async (ctx) => {
      const c = client(ctx);
      await signIn(ctx, c, ["poppy:read"]);
      const at = (await c.accountToken())!.token;
      const revoke = await raw(await ctx.fetch(`${ctx.base}/oauth/revoke`, { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: at, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: await clientAssertion(ctx.attacker.clientId, tokenEp(ctx), ctx.attacker.identity.signingKey) }) }));
      const still = await tokenPost(ctx, { grant_type: "refresh_token", refresh_token: at });
      return outcome(revoke.status === 400 && still.status === 200, `revoke ${show(revoke)}, refresh afterwards ${show(still)}`);
    } },
];

export interface AttackResult {
  id: string;
  title: string;
  expected: string;
  observed: string;
  pass: boolean;
}

export async function runAttacks(ctx: AttackContext, only?: string[]): Promise<AttackResult[]> {
  const out: AttackResult[] = [];
  for (const a of ATTACKS) {
    if (only?.length && !only.includes(a.id)) continue;
    try {
      const o = await a.run(ctx);
      out.push({ id: a.id, title: a.title, expected: a.expected, ...o });
    } catch (e) {
      out.push({ id: a.id, title: a.title, expected: a.expected, pass: false, observed: `threw: ${(e as Error).message}` });
    }
  }
  return out;
}

export function table(results: AttackResult[]): string {
  const rows = results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.title}\n      expected: ${r.expected}\n      observed: ${r.observed}`);
  const failed = results.filter((r) => !r.pass).length;
  return `${rows.join("\n")}\n\n${results.length - failed}/${results.length} attacks failed closed${failed ? `, ${failed} UNEXPECTED SUCCESS` : ""}`;
}
