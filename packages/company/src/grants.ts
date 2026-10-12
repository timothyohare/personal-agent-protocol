// Sign-in grants at the token endpoint: authorization_code (spec 4.5) and, in Task 10, refresh_token (4.8).
import { pkceChallenge, rid } from "poppy-core";
import { oauthError } from "./errors.ts";
import type { AccountToken, Session } from "./stores.ts";
import { issueSessionToken, ownedSession, type GrantHandler, type TokenDeps } from "./token.ts";

/** Signs `session` in to the account behind `at`, unless it is signed in to a different account (spec 4.4). */
export function signIn(session: Session, at: AccountToken): void {
  if (session.accountId !== null && session.accountId !== at.accountId) {
    throw oauthError("account_mismatch", 400, "this Session is signed in to a different account");
  }
  session.accountId = at.accountId;
  session.accountTokenId = at.id;
}

export function authorizationCodeGrant(d: TokenDeps): GrantHandler {
  return async ({ form, clientId, jkt }) => {
    const code = d.stores.codes.get(form.code ?? "");
    // Single use: removed on first presentation, whatever happens next (A-12).
    if (code) d.stores.codes.delete(code.code);
    if (!code || code.expiresAt <= Date.now()) throw oauthError("invalid_grant", 400, "unknown, used or expired code");
    if (code.clientId !== clientId) throw oauthError("invalid_grant", 400, "code was issued to another client");
    if (form.redirect_uri !== code.redirectUri) throw oauthError("invalid_grant", 400, "redirect_uri mismatch");
    if (!form.code_verifier || pkceChallenge(form.code_verifier) !== code.codeChallenge) {
      throw oauthError("invalid_grant", 400, "PKCE verification failed");
    }
    if (!form.session_id) throw oauthError("invalid_request", 400, "session_id required");
    const session = ownedSession(d.stores, form.session_id, clientId);

    const at: AccountToken = { id: `at_${rid()}`, token: rid(32), clientId, userId: session.userId,
      accountId: code.accountId, scope: code.scope, revoked: false };
    signIn(session, at);
    d.stores.accountTokens.set(at.token, at);
    d.c.log.event("session.signed_in", { session_id: session.id, client_id: clientId, account: at.accountId,
      scope: at.scope.join(" ") });
    // The new Session Token is bound to the key in this request's proof (spec 4.3, S4 E1).
    return { ...issueSessionToken(d, session, jkt, at.scope), refresh_token: at.token };
  };
}
