import { Hono } from "hono";
import type { JWK } from "jose";

export interface AgentHostConfig {
  /** The public origin of the agent host, e.g. https://agent.ohare.id.au */
  baseUrl: string;
  clientName: string;
  /** The agent's public signing keys, each with a `kid`. Never a private key. */
  publicJwks: JWK[];
}

export function clientId(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/agent.json`;
}

/** The Client ID Metadata Document (briefing 9.4). */
export function agentJson(c: AgentHostConfig) {
  const origin = new URL(c.baseUrl).origin;
  return {
    client_id: clientId(origin),
    client_name: c.clientName,
    jwks_uri: `${origin}/jwks.json`,
    redirect_uris: [`${origin}/oauth/callback`],
    token_endpoint_auth_method: "private_key_jwt",
  };
}

export function createAgentHost(c: AgentHostConfig): Hono {
  for (const k of c.publicJwks) {
    if ("d" in k) throw new Error("agent host must only publish public keys");
    if (!k.kid) throw new Error("every published key needs a kid");
  }
  const app = new Hono();
  app.get("/agent.json", (ctx) => ctx.json(agentJson(c)));
  app.get("/jwks.json", (ctx) => ctx.json({ keys: c.publicJwks }));
  return app;
}
