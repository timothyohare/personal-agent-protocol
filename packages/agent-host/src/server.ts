// Runs the agent host on Node: agent.json, jwks.json and (Task 8) /oauth/callback.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import type { JWK } from "jose";
import { createAgentHost } from "./app.ts";

export function startAgentHost(opts: { port?: number; baseUrl?: string; publicJwk?: JWK; clientName?: string } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 8788);
  const baseUrl = opts.baseUrl ?? process.env.AGENT_BASE_URL ?? `http://localhost:${port}`;
  const publicJwk = opts.publicJwk ?? JSON.parse(readFileSync(
    resolve(process.env.POPPY_KEYS_DIR ?? "keys", "agent-signing.public.json"), "utf8")) as JWK;
  const app = createAgentHost({ baseUrl, clientName: opts.clientName ?? process.env.AGENT_NAME ?? "Tim's Agent",
    publicJwks: [publicJwk] });
  const server = serve({ fetch: app.fetch, port });
  console.log(`[agent-host] listening on :${port} as ${baseUrl}`);
  return { app, server };
}

if (import.meta.main) startAgentHost();
