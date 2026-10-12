import { Hono } from "hono";
import type { ResolvedConfig } from "./config.ts";

export const PROTOCOL_VERSION = "0.1";

export function poppyJson(c: ResolvedConfig) {
  return {
    protocol_version: PROTOCOL_VERSION,
    organization: { name: c.name, domain: c.domain },
    auth: {
      issuer: c.issuer,
      direct: { scopes: c.scopes },
      custom_scopes: c.customScopes,
    },
    apis: [{ type: "openapi", url: `${c.baseUrl}/openapi.json`, description: c.apiDescription }],
  };
}

export function authServerMetadata(c: ResolvedConfig) {
  return {
    issuer: c.issuer,
    authorization_endpoint: c.authorizationEndpoint,
    token_endpoint: c.tokenEndpoint,
    revocation_endpoint: c.revocationEndpoint,
    poppy_domains: [c.domain],
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer", "authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["ES256"],
    dpop_signing_alg_values_supported: ["ES256"],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: c.scopes,
  };
}

export function wellKnownRoutes(c: ResolvedConfig): Hono {
  const app = new Hono();
  app.get("/.well-known/poppy.json", (ctx) => ctx.json(poppyJson(c)));
  app.get("/.well-known/oauth-authorization-server", (ctx) => ctx.json(authServerMetadata(c)));
  return app;
}
