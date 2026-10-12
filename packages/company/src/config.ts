import { silentLogger, type Logger } from "poppy-core";

export interface CompanyConfig {
  /** The public origin (PUBLIC_BASE_URL). `htu` checks and the issuer are built from it, never from request headers. */
  baseUrl: string;
  name: string;
  /** Scopes available through Direct Sign-In. */
  scopes: string[];
  /** Custom scopes and their consent-screen descriptions. */
  customScopes: Record<string, string>;
  apiDescription: string;
  /** The dev-only http://localhost exception (SecurityReview T-12). */
  devAllowHttpLocalhost: boolean;
  /** Require a server-issued DPoP nonce (exercises the agent's retry, spec 4.3). */
  requireDpopNonce?: boolean;
  sessionTokenTtlS?: number;
  /** Issue a new Account Token on every refresh (spec 4.8 allows it; the agent must then use the new one). */
  rotateAccountTokens?: boolean;
  log?: Logger;
  /** Used to fetch agent metadata and JWKS. Injected in tests. */
  fetch?: typeof fetch;
  /** DNS resolution for the SSRF guard. Injected in tests. */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export interface ResolvedConfig extends Required<Omit<CompanyConfig, "resolveHost">> {
  resolveHost: ((hostname: string) => Promise<string[]>) | undefined;
  issuer: string;
  domain: string;
  tokenEndpoint: string;
  authorizationEndpoint: string;
  revocationEndpoint: string;
}

export function resolveConfig(c: CompanyConfig): ResolvedConfig {
  const issuer = new URL(c.baseUrl).origin;
  return {
    requireDpopNonce: false,
    sessionTokenTtlS: 3600,
    rotateAccountTokens: false,
    log: silentLogger,
    fetch: globalThis.fetch,
    ...c,
    resolveHost: c.resolveHost,
    baseUrl: issuer,
    issuer,
    domain: new URL(issuer).host,
    tokenEndpoint: `${issuer}/oauth/token`,
    authorizationEndpoint: `${issuer}/oauth/authorize`,
    revocationEndpoint: `${issuer}/oauth/revoke`,
  };
}

/** Tipping Co, briefing 9.3. */
export const tippingCo = (baseUrl: string, devAllowHttpLocalhost: boolean): CompanyConfig => ({
  baseUrl,
  name: "Tipping Co",
  scopes: ["poppy:read", "poppy:write", "standings"],
  customScopes: { standings: "See your position on the competition ladder" },
  apiDescription: "Fixtures, ladder, your tips and score",
  devAllowHttpLocalhost,
});
