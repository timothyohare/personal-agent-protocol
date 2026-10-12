// API middleware (briefing 9.6 steps 1-4, spec 4.3, 6): DPoP-bound Session Tokens on every request.
import type { Context, MiddlewareHandler } from "hono";
import { DpopError, verifyDpop } from "poppy-core";
import type { ResolvedConfig } from "./config.ts";
import type { NonceManager } from "./limits.ts";
import type { Session, SessionToken, Stores } from "./stores.ts";

export interface Auth {
  session: Session;
  token: SessionToken;
  /** Signed in right now: the token was issued for the account the Session is still signed in to. */
  signedIn: boolean;
  accountId: string | null;
  scope: string[];
}

export type AuthEnv = { Variables: { auth: Auth } };

const quote = (s: string) => s.replace(/["\\]/g, "");

/** A 401/403 with `WWW-Authenticate: DPoP` and a JSON body (F5). */
export function authError(
  ctx: Context, status: 401 | 403, error: string, description: string, extra: Record<string, string> = {},
  headers: Record<string, string> = {},
): Response {
  const params = { error, error_description: description, ...extra, algs: "ES256" };
  const www = `DPoP ${Object.entries(params).map(([k, v]) => `${k}="${quote(v)}"`).join(", ")}`;
  return ctx.json({ error, error_description: description, ...extra }, status,
    { "www-authenticate": www, "cache-control": "no-store", ...headers });
}

/**
 * Whether a token is signed in right now. Checked on every request (F11): revoking the
 * Account Token signs the Session out, and the old signed-in token stops working at once.
 */
export function currentAuth(token: SessionToken, session: Session): Omit<Auth, "session" | "token"> {
  // An Account Token belongs to exactly one account, so matching its id is enough.
  const signedIn = token.accountTokenId !== null && session.accountTokenId === token.accountTokenId;
  return { signedIn, accountId: signedIn ? token.accountId : null, scope: signedIn ? token.scope : [] };
}

export function requireSessionToken(c: ResolvedConfig, stores: Stores, nonces: NonceManager): MiddlewareHandler<AuthEnv> {
  return async (ctx, next) => {
    // Tokens are read only from the Authorization header, never from the URL (spec 4.3, A-42).
    const header = ctx.req.header("authorization") ?? "";
    const m = header.match(/^DPoP\s+([A-Za-z0-9._~+/-]+=*)$/i);
    if (!m) return authError(ctx, 401, "invalid_token", "DPoP Session Token required in the Authorization header");
    const value = m[1]!;
    const token = stores.tokens.get(value);
    const session = token ? stores.sessions.get(token.sessionId) : undefined;
    if (!token || !session || token.expiresAt <= Date.now() || session.ended || token.resource !== undefined) {
      return authError(ctx, 401, "invalid_token", "unknown, expired or ended token");
    }

    const nonce = nonces.expected();
    const nonceHeader: Record<string, string> = nonce !== undefined ? { "dpop-nonce": nonce } : {};
    try {
      const htu = c.baseUrl + new URL(ctx.req.url).pathname;
      await verifyDpop(ctx.req.header("dpop"), ctx.req.method, htu, stores.replay,
        { accessToken: value, boundJkt: token.jkt, nonce });
    } catch (e) {
      const err = e as DpopError;
      c.log.event("api.rejected", { error: err.code, path: ctx.req.path, detail: err.message });
      return authError(ctx, 401, err.code ?? "invalid_dpop_proof", err.message, {}, nonceHeader);
    }
    ctx.set("auth", { session, token, ...currentAuth(token, session) });
    await next();
    for (const [k, v] of Object.entries(nonceHeader)) ctx.header(k, v);
  };
}

/** Requires a signed-in Session with `scope` (spec 6): 403 sign_in_required or insufficient_scope. */
export function requireScope(scope: string): MiddlewareHandler<AuthEnv> {
  return async (ctx, next) => {
    const auth = ctx.get("auth");
    if (!auth.signedIn) return authError(ctx, 403, "sign_in_required", "sign in to use this API", { scope });
    if (!auth.scope.includes(scope)) {
      return authError(ctx, 403, "insufficient_scope", `this API needs the ${scope} scope`, { scope });
    }
    await next();
  };
}
