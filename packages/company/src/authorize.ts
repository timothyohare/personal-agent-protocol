// Direct Sign-In (spec 4.4-4.5, PRD F7): the authorize endpoint, login and consent.
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { PoppyError, rid } from "poppy-core";
import type { ResolvedConfig } from "./config.ts";
import type { RateLimiter } from "./limits.ts";
import type { Stores } from "./stores.ts";
import { checkPassword } from "./users.ts";
import type { AgentVerifier } from "./verifyAgent.ts";
import { consentPage, errorPage, loginPage } from "./views.ts";

export const CODE_TTL_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const COOKIE = "poppy_authz";

export interface PendingAuthz {
  id: string;
  csrf: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string[];
  accountId: string | null;
  username: string | null;
  expiresAt: number;
}

/** Headers for every sign-in page: no framing (T-10), no caching, no WebMCP tools (A-41). */
const PAGE_HEADERS = {
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "permissions-policy": "tools=()",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export interface AuthorizeDeps {
  c: ResolvedConfig;
  stores: Stores;
  verifyAgent: AgentVerifier;
  loginLimiter: RateLimiter;
}

export function authorizeRoutes(d: AuthorizeDeps): Hono {
  const { c, stores } = d;
  const app = new Hono();
  const html = (ctx: Context, body: string, status = 200) => ctx.html(body, status as 200, PAGE_HEADERS);
  const fail = (ctx: Context, message: string, status = 400) => html(ctx, errorPage(c.name, message), status);

  /** An error sent back to a *validated* redirect URI, always with `iss` (spec 4.5, RFC 9207). */
  const errorRedirect = (ctx: Context, redirectUri: string, error: string, state?: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    if (state) u.searchParams.set("state", state);
    u.searchParams.set("iss", c.issuer);
    return ctx.redirect(u.toString(), 303);
  };

  const pendingFor = (ctx: Context, form: Record<string, string>): PendingAuthz | string => {
    const p = stores.pending.get(form.req ?? "");
    if (!p || p.expiresAt <= Date.now()) return "This sign-in request has expired. Start again from your agent.";
    // CSRF (T-9): the form must carry this request's token, from the browser that started it.
    if (form.csrf !== p.csrf || getCookie(ctx, COOKIE) !== p.id) return "csrf";
    return p;
  };

  const formOf = async (ctx: Context) => {
    const body = await ctx.req.parseBody({ all: true });
    const out: Record<string, string> = {};
    const scopes: string[] = [];
    for (const [k, v] of Object.entries(body)) {
      const vals = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
      if (k === "scope") scopes.push(...vals);
      else if (vals.length === 1) out[k] = vals[0]!;
    }
    return { form: out, scopes };
  };

  app.get("/oauth/authorize", async (ctx) => {
    const q = ctx.req.query();
    if (!q.client_id) return fail(ctx, "Missing client_id.");
    let agent;
    try {
      agent = await d.verifyAgent(q.client_id);
    } catch (e) {
      c.log.event("authorize.rejected", { reason: "invalid_client", detail: (e as PoppyError).detail });
      return fail(ctx, "This agent couldn't be verified.");
    }
    // Exact string match only, and never redirect to an unvalidated URI (T-8, A-16).
    if (!q.redirect_uri || !agent.meta.redirect_uris.includes(q.redirect_uri)) {
      c.log.event("authorize.rejected", { reason: "redirect_uri", client_id: q.client_id });
      return fail(ctx, "The redirect URI isn't registered for this agent.");
    }
    // PKCE S256 is required; refuse without redirecting (A-14).
    if (q.code_challenge_method !== "S256" || !q.code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) {
      c.log.event("authorize.rejected", { reason: "pkce", client_id: q.client_id });
      return fail(ctx, "PKCE with S256 is required.");
    }
    if (q.response_type !== "code") return errorRedirect(ctx, q.redirect_uri, "unsupported_response_type", q.state);
    if (!q.state) return errorRedirect(ctx, q.redirect_uri, "invalid_request");
    // scope must be present, and every scope available for Direct Sign-In (spec 4.4, A-44).
    const scope = (q.scope ?? "").split(" ").filter(Boolean);
    if (scope.length === 0 || scope.some((s) => !c.scopes.includes(s))) {
      c.log.event("authorize.rejected", { reason: "invalid_scope", scope: q.scope });
      return errorRedirect(ctx, q.redirect_uri, "invalid_scope", q.state);
    }

    const p: PendingAuthz = {
      id: rid(), csrf: rid(), clientId: q.client_id, clientName: agent.meta.client_name ?? q.client_id,
      redirectUri: q.redirect_uri, state: q.state, codeChallenge: q.code_challenge, scope: [...new Set(scope)],
      accountId: null, username: null, expiresAt: Date.now() + PENDING_TTL_MS,
    };
    stores.pending.set(p.id, p);
    setCookie(ctx, COOKIE, p.id, { httpOnly: true, sameSite: "Lax", path: "/oauth", secure: c.issuer.startsWith("https:") });
    c.log.event("authorize.started", { client_id: q.client_id, scope: p.scope.join(" ") });
    return html(ctx, loginPage({ company: c.name, clientName: p.clientName, clientHost: new URL(p.clientId).host,
      reqId: p.id, csrf: p.csrf }));
  });

  app.post("/oauth/authorize/login", async (ctx) => {
    const { form } = await formOf(ctx);
    const p = pendingFor(ctx, form);
    if (p === "csrf") return fail(ctx, "The form is invalid (CSRF check failed).", 403);
    if (typeof p === "string") return fail(ctx, p);
    const page = (error: string) => html(ctx, loginPage({ company: c.name, clientName: p.clientName,
      clientHost: new URL(p.clientId).host, reqId: p.id, csrf: p.csrf, error }), 401);
    if (d.loginLimiter.hit(`login:${p.id}`) > 0) return page("Too many attempts. Wait a minute and try again.");
    const user = checkPassword(stores.users, form.username ?? "", form.password ?? "");
    if (!user) {
      c.log.event("login.failed", { client_id: p.clientId });
      return page("Wrong username or password.");
    }
    p.accountId = user.accountId;
    p.username = user.username;
    c.log.event("login.ok", { account: user.accountId });
    return html(ctx, consentPage({ company: c.name, clientName: p.clientName, clientHost: new URL(p.clientId).host,
      reqId: p.id, csrf: p.csrf, username: user.username,
      scopes: p.scope.map((s) => ({ scope: s, description: c.customScopes[s] ?? SCOPE_TEXT[s] ?? s })) }));
  });

  app.post("/oauth/authorize/consent", async (ctx) => {
    const { form, scopes } = await formOf(ctx);
    const p = pendingFor(ctx, form);
    if (p === "csrf") return fail(ctx, "The form is invalid (CSRF check failed).", 403);
    if (typeof p === "string") return fail(ctx, p);
    if (!p.accountId) return fail(ctx, "Sign in first.");
    stores.pending.delete(p.id);
    // Never grant beyond what was requested (spec 4.4, T-17).
    const granted = p.scope.filter((s) => scopes.includes(s));
    if (form.decision !== "approve" || granted.length === 0) {
      c.log.event("consent.declined", { client_id: p.clientId });
      return errorRedirect(ctx, p.redirectUri, "access_denied", p.state);
    }
    const code = rid(32);
    stores.codes.set(code, { code, clientId: p.clientId, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge,
      scope: granted, accountId: p.accountId, expiresAt: Date.now() + CODE_TTL_MS });
    c.log.event("consent.granted", { client_id: p.clientId, scope: granted.join(" ") });
    const u = new URL(p.redirectUri);
    u.searchParams.set("code", code);
    u.searchParams.set("state", p.state);
    u.searchParams.set("iss", c.issuer);
    return ctx.redirect(u.toString(), 303);
  });

  return app;
}

const SCOPE_TEXT: Record<string, string> = {
  "poppy:read": "See your tips",
  "poppy:write": "Submit and change tips for you",
};
