import { importJWK, type CryptoKey, type JWK } from "jose";
import type { SigningKey } from "poppy-core";

/** Who the agent is: its client_id URL and the key published at its jwks_uri. */
export interface AgentIdentity {
  clientId: string;
  signingKey: SigningKey;
}

export async function loadIdentity(clientId: string, privateJwk: JWK): Promise<AgentIdentity> {
  if (!privateJwk.kid) throw new Error("signing key needs a kid");
  const privateKey = await importJWK(privateJwk, "ES256") as CryptoKey;
  return { clientId, signingKey: { privateKey, kid: privateJwk.kid } };
}
