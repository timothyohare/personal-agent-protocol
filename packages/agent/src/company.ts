// One company, from the agent's side: discovery, Session, API calls (and later sign-in).
import {
  clientAssertion, dpopProof, pkceChallenge, pkceVerifier, PoppyError, rid, sessionAssertion, silentLogger,
  type DpopKey, type Logger,
} from "poppy-core";
import { discover, type Discovery } from "./discover.ts";
import type { Fetch } from "./http.ts";
import { redirectUriFor, type AgentIdentity } from "./identity.ts";
import { dpopKeyFor, userIdFor } from "./userIds.ts";
import type { Vault } from "./vault.ts";
import { parseWwwAuthenticate } from "./wwwAuth.ts";

export const GRANT_JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** Never wait longer than this for a Retry-After. */
const MAX_RETRY_AFTER_S = 30;

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  session_id: string;
  signed_in: boolean;
  refresh_token?: string;
}

export interface SessionState {
  token: string;
  sessionId: string;
  signedIn: boolean;
  scope: string[];
  expiresAt: number;
}

export interface PendingSignIn {
  state: string;
  verifier: string;
  redirectUri: string;
  scopes: string[];
  issuer: string;
}

export interface StoredAccountToken {
  token: string;
  scope: string[];
}

export interface CallResult {
  status: number;
  body: unknown;
  /** The error code from the body or WWW-Authenticate, for 4xx/5xx. */
  error?: string;
  /** For insufficient_scope: the scope the route needs. */
  requiredScope?: string;
}

export interface AgentDeps {
  identity: AgentIdentity;
  vault: Vault;
  fetch?: Fetch;
  allowHttpLocalhost?: boolean;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(res: Response): number {
  const s = Number(res.headers.get("retry-after"));
  return Math.min(Number.isFinite(s) && s > 0 ? s : 1, MAX_RETRY_AFTER_S) * 1000;
}

export class CompanyClient {
  readonly input: string;
  protected readonly d: Required<AgentDeps>;
  discovery: Discovery | undefined;
  session: SessionState | undefined;
  /** The sign-in in progress, if any. */
  pendingSignIn: PendingSignIn | undefined;
  /** DPoP nonces by origin (the token endpoint and APIs may differ). */
  private nonces = new Map<string, string>();

  constructor(input: string, deps: AgentDeps) {
    this.input = input;
    this.d = {
      fetch: globalThis.fetch, allowHttpLocalhost: false, log: silentLogger, sleep: defaultSleep, ...deps,
    };
  }

  get log(): Logger { return this.d.log; }

  async discovered(): Promise<Discovery> {
    this.discovery ??= await discover(this.input, {
      fetch: this.d.fetch, allowHttpLocalhost: this.d.allowHttpLocalhost, log: this.d.log,
    });
    return this.discovery;
  }

  async issuer(): Promise<string> { return (await this.discovered()).metadata.issuer; }
  async userId(): Promise<string> { return userIdFor(this.d.vault, await this.issuer()); }
  async dpopKey(): Promise<DpopKey> { return dpopKeyFor(this.d.vault, await this.issuer()); }

  /** The origin APIs live on: the OpenAPI document's origin, else the company domain. */
  async apiOrigin(): Promise<string> {
    const disc = await this.discovered();
    const api = disc.poppy.apis?.find((a) => a.type === "openapi");
    return api ? new URL(api.url).origin : `https://${disc.domain}`;
  }

  /**
   * POSTs to the token endpoint with a client assertion and a fresh DPoP proof.
   * Retries once on use_dpop_nonce and once on 429 (spec 4.2, 4.3; S4 G5, G6).
   */
  async tokenRequest(params: () => Promise<Record<string, string>>): Promise<TokenResponse> {
    const { metadata } = await this.discovered();
    const endpoint = metadata.token_endpoint;
    const origin = new URL(endpoint).origin;
    const key = await this.dpopKey();
    let nonceRetried = false;
    let rateRetried = false;
    for (;;) {
      const nonce = this.nonces.get(origin);
      const body = new URLSearchParams({
        ...(await params()),
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await clientAssertion(this.d.identity.clientId, endpoint, this.d.identity.signingKey),
      });
      const res = await this.d.fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          dpop: await dpopProof(key, "POST", endpoint, nonce !== undefined ? { nonce } : {}),
        },
        body,
      });
      const newNonce = res.headers.get("dpop-nonce");
      if (newNonce) this.nonces.set(origin, newNonce);
      const json = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (res.ok) return json as unknown as TokenResponse;
      if (res.status === 400 && json.error === "use_dpop_nonce" && newNonce && !nonceRetried) {
        nonceRetried = true;
        this.d.log.event("dpop.nonce_retry", { endpoint });
        continue;
      }
      if (res.status === 429 && !rateRetried) {
        rateRetried = true;
        const ms = retryAfterMs(res);
        this.d.log.event("rate_limited.waiting", { endpoint, seconds: ms / 1000 });
        await this.d.sleep(ms);
        continue;
      }
      throw new PoppyError(String(json.error ?? `http_${res.status}`), res.status,
        typeof json.error_description === "string" ? json.error_description : undefined);
    }
  }

  protected adoptToken(t: TokenResponse): SessionState {
    if (t.token_type !== "DPoP") throw new PoppyError("invalid_token_response", 0, `token_type ${t.token_type}`);
    this.session = {
      token: t.access_token,
      sessionId: t.session_id,
      signedIn: t.signed_in,
      scope: t.scope ? t.scope.split(" ") : [],
      expiresAt: Date.now() + t.expires_in * 1000,
    };
    return this.session;
  }

  /** Starts a signed-out Session (JWT-bearer grant), or renews the current one with its session_id. */
  async startSession(opts: { renew?: boolean } = {}): Promise<SessionState> {
    const { metadata } = await this.discovered();
    const userId = await this.userId();
    const renewId = opts.renew ? this.session?.sessionId : undefined;
    const t = await this.tokenRequest(async () => ({
      grant_type: GRANT_JWT_BEARER,
      assertion: await sessionAssertion(this.d.identity.clientId, userId, metadata.token_endpoint,
        this.d.identity.signingKey),
      ...(renewId ? { session_id: renewId } : {}),
    }));
    const s = this.adoptToken(t);
    this.d.log.event(renewId ? "session.renewed" : "session.started",
      { company: metadata.issuer, session_id: s.sessionId, signed_in: s.signedIn });
    return s;
  }

  /** A usable Session Token: the current one, or a fresh session if none or nearly expired. */
  async ensureSession(): Promise<SessionState> {
    if (this.session && this.session.expiresAt - Date.now() > 30_000) return this.session;
    return this.startSession();
  }

  /**
   * Calls an API with `Authorization: DPoP` and a fresh proof (never a token in the URL).
   * Retries once on use_dpop_nonce, once on 429 and once with a new Session on invalid_token.
   */
  async call(method: string, path: string, body?: unknown): Promise<CallResult> {
    const url = new URL(path, await this.apiOrigin());
    if (url.origin !== await this.apiOrigin()) throw new PoppyError("invalid_request", 0, "path must be relative");
    const key = await this.dpopKey();
    const retried = { nonce: false, rate: false, token: false };
    for (;;) {
      const s = await this.ensureSession();
      const nonce = this.nonces.get(url.origin);
      const res = await this.d.fetch(url, {
        method,
        headers: {
          authorization: `DPoP ${s.token}`,
          dpop: await dpopProof(key, method, url.toString(),
            { accessToken: s.token, ...(nonce !== undefined ? { nonce } : {}) }),
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const newNonce = res.headers.get("dpop-nonce");
      if (newNonce) this.nonces.set(url.origin, newNonce);
      const www = parseWwwAuthenticate(res.headers.get("www-authenticate"));
      const json = await res.json().catch(() => null) as Record<string, unknown> | null;
      const error = www.error ?? (typeof json?.error === "string" ? json.error : undefined);
      if (res.status === 401 && error === "use_dpop_nonce" && newNonce && !retried.nonce) {
        retried.nonce = true;
        continue;
      }
      if (res.status === 429 && !retried.rate) {
        retried.rate = true;
        await this.d.sleep(retryAfterMs(res));
        continue;
      }
      if (res.status === 401 && error === "invalid_token" && !retried.token) {
        retried.token = true;
        this.session = undefined;
        await this.onInvalidToken();
        continue;
      }
      this.d.log.event("api.call", { method, path: url.pathname, status: res.status, error });
      const result: CallResult = { status: res.status, body: json };
      if (!res.ok && error) result.error = error;
      if (www.scope) result.requiredScope = www.scope;
      return result;
    }
  }

  /** Hook for subclasses: get a new token after invalid_token (Task 10 uses the Account Token). */
  protected async onInvalidToken(): Promise<void> {}

  private accountKey = async () => `account_token:${await this.issuer()}`;

  async accountToken(): Promise<StoredAccountToken | undefined> {
    const v = await this.d.vault.get(await this.accountKey());
    return v ? JSON.parse(v) as StoredAccountToken : undefined;
  }

  protected async saveAccountToken(t: StoredAccountToken): Promise<void> {
    await this.d.vault.set(await this.accountKey(), JSON.stringify(t));
  }

  protected async forgetAccountToken(): Promise<void> {
    await this.d.vault.delete(await this.accountKey());
  }

  /**
   * Starts Direct Sign-In (spec 4.5): makes sure there's a Session, then builds the authorize URL
   * with PKCE (S256) and a fresh `state`. The user opens the URL and signs in themselves (spec 4.4).
   * `loopbackPort` is carried in `state` so the agent host's callback page can find the CLI.
   */
  async beginSignIn(scopes: string[], opts: { loopbackPort?: number } = {}): Promise<string> {
    const { metadata } = await this.discovered();
    await this.ensureSession();
    const state = opts.loopbackPort ? `${rid()}.${opts.loopbackPort}` : rid();
    const verifier = pkceVerifier();
    const redirectUri = redirectUriFor(this.d.identity.clientId);
    this.pendingSignIn = { state, verifier, redirectUri, scopes, issuer: metadata.issuer };
    const u = new URL(metadata.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: "code", client_id: this.d.identity.clientId, redirect_uri: redirectUri, scope: scopes.join(" "),
      state, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256",
    }).toString();
    this.d.log.event("signin.started", { company: metadata.issuer, scope: scopes.join(" ") });
    return u.toString();
  }

  /**
   * Finishes Direct Sign-In with the callback's parameters. Checks `state` and `iss` (F9, RFC 9207)
   * before sending anything, exchanges the code for an Account Token and a signed-in Session Token,
   * and stores the Account Token in the vault.
   */
  async completeSignIn(callback: string | URLSearchParams): Promise<SessionState> {
    const p = typeof callback === "string" ? new URL(callback).searchParams : callback;
    const pending = this.pendingSignIn;
    this.pendingSignIn = undefined;
    const abort = (code: string, detail: string) => {
      this.d.log.event("signin.aborted", { reason: code, detail });
      return new PoppyError(code, 0, detail);
    };
    if (!pending) throw abort("no_signin_pending", "no sign-in in progress");
    if (p.get("state") !== pending.state) throw abort("state_mismatch", "state does not match (A-15)");
    if (p.get("iss") !== pending.issuer) throw abort("iss_mismatch", `iss ${p.get("iss")} is not ${pending.issuer} (A-05)`);
    const error = p.get("error");
    if (error) throw abort(error, p.get("error_description") ?? "the company returned an error");
    const code = p.get("code");
    if (!code) throw abort("invalid_callback", "no code");

    const sessionId = (await this.ensureSession()).sessionId;
    const t = await this.tokenRequest(async () => ({
      grant_type: "authorization_code", code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier,
      session_id: sessionId,
    }));
    if (!t.refresh_token) throw new PoppyError("invalid_token_response", 0, "no Account Token in the response");
    if (t.session_id !== sessionId) throw new PoppyError("invalid_token_response", 0, "session_id changed");
    const s = this.adoptToken(t);
    await this.saveAccountToken({ token: t.refresh_token, scope: s.scope });
    const missing = pending.scopes.filter((x) => !s.scope.includes(x));
    if (missing.length) this.d.log.event("signin.scope_narrowed", { missing: missing.join(" ") });
    this.d.log.event("signin.complete", { company: pending.issuer, session_id: s.sessionId, scope: s.scope.join(" ") });
    return s;
  }
}
