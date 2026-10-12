// Agent signing keys on disk. The private JWK lives in a git-ignored directory (keys/ by
// default, or $POPPY_KEYS_DIR), written with 0600 permissions.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from "jose";

export const keysDir = (): string => resolve(process.env.POPPY_KEYS_DIR ?? "keys");
const privatePath = (dir: string, name = "agent") => join(dir, `${name}-signing.private.json`);
const publicPath = (dir: string, name = "agent") => join(dir, `${name}-signing.public.json`);

/** `name` lets the dev boot keep a second ("attacker") agent's keys beside the real one. */
export async function generateAgentKeys(dir = keysDir(), force = false, name = "agent"): Promise<{ publicJwk: JWK; created: boolean }> {
  if (!force && existsSync(privatePath(dir, name))) return { publicJwk: readPublicJwk(dir, name), created: false };
  const kp = await generateKeyPair("ES256", { extractable: true });
  const pub = await exportJWK(kp.publicKey);
  const kid = (await calculateJwkThumbprint(pub, "sha256")).slice(0, 16);
  const publicJwk: JWK = { ...pub, kid, alg: "ES256", use: "sig" };
  const privateJwk: JWK = { ...(await exportJWK(kp.privateKey)), kid, alg: "ES256" };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(privatePath(dir, name), JSON.stringify(privateJwk, null, 2), { mode: 0o600 });
  chmodSync(privatePath(dir, name), 0o600);
  writeFileSync(publicPath(dir, name), JSON.stringify(publicJwk, null, 2));
  return { publicJwk, created: true };
}

export function readPublicJwk(dir = keysDir(), name = "agent"): JWK {
  return JSON.parse(readFileSync(publicPath(dir, name), "utf8")) as JWK;
}

export function readPrivateJwk(dir = keysDir(), name = "agent"): JWK {
  return JSON.parse(readFileSync(privatePath(dir, name), "utf8")) as JWK;
}
