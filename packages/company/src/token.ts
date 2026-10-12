// The token endpoint (spec 4.2, 4.5, 4.8): session start and renewal, code exchange, refresh.
import { Hono, type Context } from "hono";
import { decodeJwt } from "jose";
import { AssertionError, DpopError, PoppyError, verifyAssertion, verifyDpop } from "poppy-core";
import type { ResolvedConfig } from "./config.ts";
import { errorResponse, oauthError } from "./errors.ts";
import type { NonceManager, RateLimiter } from "./limits.ts";
import { newOpaqueToken, newSessionId, type Session, type Stores } from "./stores.ts";
import type { AgentVerifier, VerifiedAgent } from "./verifyAgent.ts";

export const GRANT_JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

export interface TokenContext {
  form: Record<string, string>;
  clientId: string;
  agent: VerifiedAgent;
  /** Thumbprint of the DPoP key in this request's proof. Each new token is bound to it (spec 4.3). */
  jkt: string;
}

export type GrantHandler = (t: TokenContext) => Promise<Record<string, unknown>>;

export interface TokenDeps {
  c: ResolvedConfig;
  stores: Stores;
  verifyAgent: AgentVerifier;
  nonces: NonceManager;
  limiter: RateLimiter;
}

/** Client IP for rate limiting. In-process requests have no socket and share one bucket. */
export function clientIp(ctx: Context): string {
  const incoming = (ctx.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? "local";
}

async function readForm(ctx: Context): Promise<Record<string, string>> {
  if (!/^application\/x-www-form-urlencoded\b/i.test(ctx.req.header("content-type") ?? "")) {
    throw oauthError("invalid_request", 400, "body must be application/x-www-form-urlencoded");
  }
  const params = new URLSearchParams(await ctx.req.text());
  const form: Record<string, string> = {};
  for (const [k, v] of params) {
    if (k in form) throw oauthError("invalid_request", 400, `duplicate parameter ${k}`);
    form[k] = v;
  }
  return form;
}

/** Authenticates the agent with its client assertion (`private_key_jwt`). Failures are 401 invalid_client. */
export async function authenticateClient(
  form: Record<string, string>, d: Pick<TokenDeps, "c" | "stores" | "verifyAgent">,
): Promise<{ clientId: string; agent: VerifiedAgent }> {
  if (form.client_assertion_type !== CLIENT_ASSERTION_TYPE || !form.client_assertion) {
    throw oauthError("invalid_client", 401, "client assertion required");
  }
  let clientId: string;
  try {
    const iss = decodeJwt(form.client_assertion).iss;
    if (typeof iss !== "string") throw new Error("no iss");
    clientId = iss;
  } catch {
    throw oauthError("invalid_client", 401, "malformed client assertion");
  }
  if (form.client_id !== undefined && form.client_id !== clientId) {
    throw oauthError("invalid_client", 401, "client_id does not match the assertion");
  }
  const agent = await d.verifyAgent(clientId);
  try {
    await verifyAssertion(form.client_assertion, agent.jwks,
      { issuer: clientId, audience: d.c.tokenEndpoint, subject: clientId, replay: d.stores.replay });
  } catch (e) {
    throw oauthError("invalid_client", 401, `client assertion: ${(e as Error).message}`);
  }
  return { clientId, agent };
}

/** Issues a DPoP-bound Session Token and builds the spec 4.2 response. */
export async function issueSessionToken(
  d: Pick<TokenDeps, "c" | "stores">, session: Session, jkt: string, scope: string[] = [],
): Promise<Record<string, unknown>> {
  const token = newOpaqueToken();
  const signedIn = session.accountId !== null;
  const expiresAt = Date.now() + d.c.sessionTokenTtlS * 1000;
  await d.stores.tokens.put(token, {
    token, sessionId: session.id, jkt, accountId: session.accountId, accountTokenId: session.accountTokenId,
    scope: signedIn ? scope : [], expiresAt,
  }, expiresAt);
  return {
    access_token: token,
    token_type: "DPoP",
    expires_in: d.c.sessionTokenTtlS,
    scope: signedIn ? scope.join(" ") : "",
    session_id: session.id,
    signed_in: signedIn,
  };
}

/** Looks up a Session the caller may use: live, same agent and same User (spec 4.2, 4.8). */
export async function ownedSession(stores: Stores, sessionId: string, clientId: string, userId?: string): Promise<Session> {
  const s = await stores.sessions.get(sessionId);
  if (!s || s.ended || s.clientId !== clientId || (userId !== undefined && s.userId !== userId)) {
    throw oauthError("invalid_session", 400, "unknown session, or not yours");
  }
  return s;
}

/** The JWT-bearer session grant: start a signed-out Session, or renew one with `session_id`. */
function jwtBearerGrant(d: TokenDeps): GrantHandler {
  return async ({ form, clientId, agent, jkt }) => {
    let sub: string;
    try {
      ({ sub } = await verifyAssertion(form.assertion, agent.jwks,
        { issuer: clientId, audience: d.c.tokenEndpoint, replay: d.stores.replay }));
    } catch (e) {
      throw oauthError("invalid_grant", 400, `session assertion: ${(e as AssertionError).message}`);
    }
    if (form.session_id !== undefined) {
      const s = await ownedSession(d.stores, form.session_id, clientId, sub);
      d.c.log.event("session.renewed", { session_id: s.id, client_id: clientId });
      // A renewal through the assertion carries no account access (the Account Token does that).
      return issueSessionToken(d, { ...s, accountId: null, accountTokenId: null }, jkt);
    }
    const session: Session = {
      id: newSessionId(), clientId, userId: sub, accountId: null, accountTokenId: null, ended: false,
      createdAt: Date.now(),
    };
    await d.stores.sessions.put(session.id, session);
    d.c.log.event("session.started", { session_id: session.id, client_id: clientId, user_id: sub, signed_in: false });
    return issueSessionToken(d, session, jkt);
  };
}

export function tokenRoutes(d: TokenDeps, extraGrants: Record<string, GrantHandler> = {}): Hono {
  const grants: Record<string, GrantHandler> = { [GRANT_JWT_BEARER]: jwtBearerGrant(d), ...extraGrants };
  const app = new Hono();

  app.post("/oauth/token", async (ctx) => {
    const nonceHeader: Record<string, string> = {};
    try {
      const wait = d.limiter.hit(`token:${clientIp(ctx)}`);
      if (wait > 0) {
        return errorResponse(ctx, oauthError("rate_limited", 429, "slow down"), { "retry-after": String(wait) });
      }
      const form = await readForm(ctx);
      const grant = grants[form.grant_type ?? ""];
      if (!grant) throw oauthError("unsupported_grant_type", 400, `grant_type ${form.grant_type ?? "(missing)"}`);

      const nonce = d.nonces.expected();
      if (nonce !== undefined) nonceHeader["dpop-nonce"] = nonce;
      let jkt: string;
      try {
        jkt = await verifyDpop(ctx.req.header("dpop"), "POST", d.c.tokenEndpoint, d.stores.replay, { nonce });
      } catch (e) {
        // At the token endpoint, DPoP errors are 400 (spec 4.2, S4 E3).
        throw oauthError((e as DpopError).code ?? "invalid_dpop_proof", 400, (e as Error).message);
      }

      const { clientId, agent } = await authenticateClient(form, d);
      const body = await grant({ form, clientId, agent, jkt });
      return ctx.json(body, 200, { "cache-control": "no-store", ...nonceHeader });
    } catch (e) {
      if (e instanceof PoppyError) {
        d.c.log.event("token.rejected", { error: e.code, detail: e.detail });
        return errorResponse(ctx, e, nonceHeader);
      }
      throw e;
    }
  });
  return app;
}
