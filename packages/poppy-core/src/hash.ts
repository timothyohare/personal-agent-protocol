import { createHash, randomBytes } from "node:crypto";

/** A random base64url identifier. 16 bytes gives the 128 bits the spec asks for in a `jti`. */
export const rid = (bytes = 16): string => randomBytes(bytes).toString("base64url");

export const sha256b64url = (s: string): string => createHash("sha256").update(s).digest("base64url");

/** PKCE S256 challenge for a code verifier (RFC 7636 §4.2). */
export const pkceChallenge = (verifier: string): string => sha256b64url(verifier);

/** A PKCE code verifier: 32 random bytes, 43 base64url characters (RFC 7636 §4.1). */
export const pkceVerifier = (): string => rid(32);
