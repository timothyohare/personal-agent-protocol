// Runs Tipping Co on Node. PUBLIC_BASE_URL sets the issuer and every htu check.
import { serve } from "@hono/node-server";
import { createLogger, devAllowHttpLocalhost, processSink } from "poppy-core";
import { createCompany } from "./app.ts";
import { tippingCo } from "./config.ts";

export function startCompany(opts: { port?: number; baseUrl?: string } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const baseUrl = opts.baseUrl ?? process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
  const company = createCompany({
    ...tippingCo(baseUrl, devAllowHttpLocalhost()),
    requireDpopNonce: process.env.POPPY_REQUIRE_DPOP_NONCE === "1",
    log: createLogger("company", processSink()),
  });
  const server = serve({ fetch: company.app.fetch, port });
  console.log(`[company] ${company.config.name} listening on :${port} as ${company.config.issuer}`);
  return { company, server };
}

if (import.meta.main) startCompany();
