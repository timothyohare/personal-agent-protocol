// Signing out (spec 4.9): revoke the Account Token with the agent's client assertion. Its Sessions
// carry on signed out, and the API middleware sees that on the very next request (F11).
import { Hono } from "hono";
import { PoppyError } from "poppy-core";
import { errorResponse, oauthError } from "./errors.ts";
import { authenticateClient, clientIp, type TokenDeps } from "./token.ts";

export function revokeRoutes(d: TokenDeps): Hono {
  const app = new Hono();
  app.post("/oauth/revoke", async (ctx) => {
    try {
      const wait = d.limiter.hit(`token:${clientIp(ctx)}`);
      if (wait > 0) return errorResponse(ctx, oauthError("rate_limited", 429, "slow down"), { "retry-after": String(wait) });
      if (!/^application\/x-www-form-urlencoded\b/i.test(ctx.req.header("content-type") ?? "")) {
        throw oauthError("invalid_request", 400, "body must be application/x-www-form-urlencoded");
      }
      const form = Object.fromEntries(new URLSearchParams(await ctx.req.text()));
      const { clientId } = await authenticateClient(form, d);
      if (!form.token) throw oauthError("invalid_request", 400, "token required");

      const at = await d.stores.accountTokens.get(form.token);
      if (at) {
        // Accepted only from the client_id it was issued to (S4 G12, A-46).
        if (at.clientId !== clientId) throw oauthError("invalid_request", 400, "token was issued to another client");
        await d.stores.accountTokens.delete(at.token);
        const signedOut = await d.stores.sessions.signOutByAccountToken(at.id);
        d.c.log.event("account_token.revoked", { client_id: clientId, account: at.accountId, sessions_signed_out: signedOut });
      } else {
        const st = await d.stores.tokens.get(form.token);
        const owner = st ? await d.stores.sessions.get(st.sessionId) : undefined;
        if (st && owner?.clientId === clientId) {
          await d.stores.tokens.delete(form.token);
          d.c.log.event("session_token.revoked", { client_id: clientId, session_id: st.sessionId });
        }
      }
      // RFC 7009: an unknown token is not an error.
      return ctx.body(null, 200, { "cache-control": "no-store" });
    } catch (e) {
      if (e instanceof PoppyError) {
        d.c.log.event("revoke.rejected", { error: e.code, detail: e.detail });
        return errorResponse(ctx, e);
      }
      throw e;
    }
  });
  return app;
}
