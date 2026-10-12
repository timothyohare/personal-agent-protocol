// Sign-in grants at the token endpoint: authorization_code (spec 4.5) and refresh_token (4.8).
import { pkceChallenge, rid } from "poppy-core";
import { oauthError } from "./errors.ts";
import { newSessionId, type AccountToken, type Session } from "./stores.ts";
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

/**
 * The Account Token refresh (spec 4.8, PRD F10). Bound to the client_id that received it, not to a
 * DPoP key: the new Session Token is bound to the key in this request's proof (S4 E1).
 * With session_id it signs that Session in; without, it starts a new signed-in Session.
 */
export function refreshTokenGrant(d: TokenDeps): GrantHandler {
  return async ({ form, clientId, jkt }) => {
    const at = d.stores.accountTokens.get(form.refresh_token ?? "");
    if (!at || at.revoked) throw oauthError("invalid_grant", 400, "unknown or revoked Account Token");
    // A stolen Account Token is useless with another agent's client assertion (A-20).
    if (at.clientId !== clientId) throw oauthError("invalid_grant", 400, "Account Token was issued to another client");

    let scope = at.scope;
    if (form.scope !== undefined) {
      const asked = form.scope.split(" ").filter(Boolean);
      // May narrow, never widen (S4 G8).
      if (asked.length === 0 || asked.some((s) => !at.scope.includes(s))) {
        throw oauthError("invalid_scope", 400, "scope can only narrow the Account Token's scope");
      }
      scope = asked;
    }

    let session: Session;
    if (form.session_id !== undefined) {
      session = ownedSession(d.stores, form.session_id, clientId, at.userId);
      signIn(session, at);
    } else {
      session = { id: newSessionId(), clientId, userId: at.userId, accountId: at.accountId, accountTokenId: at.id,
        ended: false, createdAt: Date.now() };
      d.stores.sessions.set(session.id, session);
    }
    const body: Record<string, unknown> = issueSessionToken(d, session, jkt, scope);
    if (d.c.rotateAccountTokens) {
      d.stores.accountTokens.delete(at.token);
      at.token = rid(32);
      d.stores.accountTokens.set(at.token, at);
      body.refresh_token = at.token;
    }
    d.c.log.event("session.refreshed", { session_id: session.id, client_id: clientId, account: at.accountId,
      new_session: form.session_id === undefined, rotated: d.c.rotateAccountTokens });
    return body;
  };
}
