// Per-company User IDs and DPoP keys (spec 4.2, PRD F2, F29).
import { exportJWK, importJWK, type CryptoKey, type JWK } from "jose";
import { newDpopKey, rid, type DpopKey } from "poppy-core";
import type { Vault } from "./vault.ts";

/** A random, per-issuer User ID, never derived from personal data, reused across runs. */
export async function userIdFor(vault: Vault, issuer: string): Promise<string> {
  const key = `user_id:${issuer}`;
  const existing = await vault.get(key);
  if (existing) return existing;
  const id = `u_${rid()}`;
  await vault.set(key, id);
  return id;
}

/** This user's DPoP key for one company, kept in the vault (S5 F2). */
export async function dpopKeyFor(vault: Vault, issuer: string): Promise<DpopKey> {
  const key = `dpop_key:${issuer}`;
  const stored = await vault.get(key);
  if (stored) {
    const jwk = JSON.parse(stored) as JWK;
    const { d: _d, ...publicJwk } = jwk;
    return { privateKey: await importJWK(jwk, "ES256", { extractable: true }) as CryptoKey, publicJwk };
  }
  const k = await newDpopKey();
  await vault.set(key, JSON.stringify(await exportJWK(k.privateKey)));
  return k;
}
