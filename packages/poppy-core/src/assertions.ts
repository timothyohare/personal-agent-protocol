// Client and session assertions (private_key_jwt and the JWT-bearer session grant, spec 4.1-4.2).
import { SignJWT, jwtVerify, type CryptoKey, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { rid } from "./hash.ts";
import { MIN_JTI_LENGTH } from "./dpop.ts";
import type { ReplayStore } from "./replay.ts";

export const ASSERTION_LIFETIME_S = 60;
/** Reject assertions issued more than this long ago, even if `exp` is further out. */
export const ASSERTION_MAX_AGE_S = 300;
const SKEW_S = 5;

export interface SigningKey {
  privateKey: CryptoKey;
  kid: string;
}

async function sign(iss: string, sub: string, aud: string, key: SigningKey): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: key.kid })
    .setIssuer(iss).setSubject(sub).setAudience(aud)
    .setIssuedAt().setExpirationTime(`${ASSERTION_LIFETIME_S}s`).setJti(rid())
    .sign(key.privateKey);
}

/** Client assertion (`private_key_jwt`): "I am this agent". `aud` is the token endpoint. */
export const clientAssertion = (clientId: string, tokenEndpoint: string, key: SigningKey): Promise<string> =>
  sign(clientId, clientId, tokenEndpoint, key);

/** Session assertion: "I am this agent, acting for this user at your company". */
export const sessionAssertion = (
  clientId: string, userId: string, tokenEndpoint: string, key: SigningKey,
): Promise<string> => sign(clientId, userId, tokenEndpoint, key);

export class AssertionError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "AssertionError";
  }
}

export interface VerifyAssertionOptions {
  issuer: string;
  /** The single audience value required (our token endpoint). An array `aud` is rejected. */
  audience: string;
  /** If set, `sub` must equal this (client assertions: `sub` = `client_id`). */
  subject?: string;
  replay: ReplayStore;
}

/** Verifies an assertion against the agent's JWKS. The `jti` is recorded last. */
export async function verifyAssertion(
  jwt: string | undefined, keys: JWTVerifyGetKey, opts: VerifyAssertionOptions,
): Promise<JWTPayload & { sub: string; jti: string }> {
  if (!jwt) throw new AssertionError("missing assertion");
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(jwt, keys, {
      algorithms: ["ES256"],
      issuer: opts.issuer,
      audience: opts.audience,
      requiredClaims: ["exp", "iat", "jti", "sub"],
      maxTokenAge: `${ASSERTION_MAX_AGE_S}s`,
      clockTolerance: SKEW_S,
      subject: opts.subject,
    }));
  } catch (e) {
    throw new AssertionError((e as Error).message);
  }
  // jose accepts an array `aud` that contains ours. The spec wants a single string (briefing 9.9).
  if (typeof payload.aud !== "string") throw new AssertionError("aud must be a single string");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new AssertionError("sub missing");
  if (typeof payload.jti !== "string" || payload.jti.length < MIN_JTI_LENGTH) {
    throw new AssertionError("jti missing or too short");
  }
  // Remember the jti until the assertion can no longer pass the exp check.
  const ttlMs = assertionReplayTtlMs(payload.exp as number, Date.now());
  if (!(await opts.replay.checkAndAdd(`assertion:${opts.issuer}:${payload.jti}`, ttlMs))) {
    throw new AssertionError("jti replay");
  }
  return payload as JWTPayload & { sub: string; jti: string };
}

/** How long to remember an assertion's jti: until `exp` plus skew, and at least one second. */
export function assertionReplayTtlMs(exp: number, nowMs: number): number {
  return Math.max((exp + SKEW_S) * 1000 - nowMs, 1000);
}
