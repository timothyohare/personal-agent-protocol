// DPoP (RFC 9449) proofs: signing on the agent side, verification on the company side.
// Ported from spike S5 (docs/spikes/S5-jose-dpop.md).
import {
  EmbeddedJWK, SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, jwtVerify,
  type CryptoKey, type JWK,
} from "jose";
import { rid, sha256b64url } from "./hash.ts";
import type { ReplayStore } from "./replay.ts";

export const DPOP_MAX_AGE_S = 60;
export const DPOP_SKEW_S = 5;
export const MIN_JTI_LENGTH = 16;
/** Long enough to cover the proof's whole acceptance window (age plus skew). */
export const DPOP_REPLAY_TTL_MS = (DPOP_MAX_AGE_S + 2 * DPOP_SKEW_S) * 1000;

export interface DpopKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

/**
 * htu normalisation (RFC 9449 §4.3): compare without query and fragment, using RFC 3986
 * syntax-based normalisation. Scheme and host are lowercased and default ports dropped;
 * the path is kept exactly (a trailing slash is significant).
 */
export function normalizeHtu(url: string): string {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** A new ES256 DPoP key. Extractable, so the agent can keep it in its vault (S5 F2). */
export async function newDpopKey(): Promise<DpopKey> {
  const keys = await generateKeyPair("ES256", { extractable: true });
  return { privateKey: keys.privateKey, publicJwk: await exportJWK(keys.publicKey) };
}

export const jwkThumbprint = (jwk: JWK): Promise<string> => calculateJwkThumbprint(jwk, "sha256");

export interface DpopProofOptions {
  accessToken?: string;
  nonce?: string;
  /** Test hooks: override the issue time, `jti`, header key or `typ`. */
  iat?: number;
  jti?: string;
  headerJwk?: JWK;
  typ?: string;
}

export async function dpopProof(key: DpopKey, method: string, url: string, opts: DpopProofOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = { htm: method, htu: normalizeHtu(url), jti: opts.jti ?? rid() };
  if (opts.accessToken !== undefined) claims.ath = sha256b64url(opts.accessToken);
  if (opts.nonce !== undefined) claims.nonce = opts.nonce;
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ typ: opts.typ ?? "dpop+jwt", alg: "ES256", jwk: opts.headerJwk ?? key.publicJwk });
  if (opts.iat !== undefined) jwt.setIssuedAt(opts.iat);
  else jwt.setIssuedAt();
  return jwt.sign(key.privateKey);
}

export type DpopErrorCode = "invalid_dpop_proof" | "use_dpop_nonce";

export class DpopError extends Error {
  readonly code: DpopErrorCode;
  constructor(code: DpopErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "DpopError";
    this.code = code;
  }
}

export interface VerifyDpopOptions {
  /** The access token the proof must be bound to (`ath`). Required at APIs, absent at the token endpoint. */
  accessToken?: string;
  /** The key thumbprint the access token is bound to. */
  boundJkt?: string;
  /** A server-issued nonce the proof must carry. */
  nonce?: string;
}

/**
 * Verifies a DPoP proof and returns the RFC 7638 thumbprint of its key.
 * The `jti` is recorded only after every other check passes, so a broken copy of a
 * captured proof can't burn its `jti` (S5 correction 3).
 */
export async function verifyDpop(
  proof: string | undefined, method: string, url: string, replay: ReplayStore, opts: VerifyDpopOptions = {},
): Promise<string> {
  if (!proof) throw new DpopError("invalid_dpop_proof", "missing DPoP proof");
  let payload, protectedHeader;
  try {
    ({ payload, protectedHeader } = await jwtVerify(proof, EmbeddedJWK, {
      typ: "dpop+jwt",
      algorithms: ["ES256"],
      maxTokenAge: `${DPOP_MAX_AGE_S}s`,
      clockTolerance: DPOP_SKEW_S,
    }));
  } catch (e) {
    throw new DpopError("invalid_dpop_proof", (e as Error).message);
  }
  const jwk = protectedHeader.jwk as JWK;
  // Second layer: jose's EmbeddedJWK already refuses a private JWK (S5).
  if ("d" in jwk) throw new DpopError("invalid_dpop_proof", "private key in header");
  if (payload.htm !== method) throw new DpopError("invalid_dpop_proof", "htm mismatch");
  if (payload.htu !== normalizeHtu(url)) throw new DpopError("invalid_dpop_proof", "htu mismatch");
  if (typeof payload.jti !== "string" || payload.jti.length < MIN_JTI_LENGTH) {
    throw new DpopError("invalid_dpop_proof", "jti missing or too short");
  }
  if (opts.nonce !== undefined && payload.nonce !== opts.nonce) throw new DpopError("use_dpop_nonce", "nonce required");
  if (opts.accessToken !== undefined && payload.ath !== sha256b64url(opts.accessToken)) {
    throw new DpopError("invalid_dpop_proof", "ath mismatch");
  }
  const jkt = await jwkThumbprint(jwk);
  if (opts.boundJkt !== undefined && jkt !== opts.boundJkt) {
    throw new DpopError("invalid_dpop_proof", "key not bound to token");
  }
  if (!(await replay.checkAndAdd(`dpop:${payload.jti}`, DPOP_REPLAY_TTL_MS))) {
    throw new DpopError("invalid_dpop_proof", "jti replay");
  }
  return jkt;
}
