// Runs Tipping Co on Node. PUBLIC_BASE_URL sets the issuer and every htu check.
import { serve } from "@hono/node-server";
import { createLogger, devAllowHttpLocalhost, processSink } from "poppy-core";
import { createCompany } from "./app.ts";
import { tippingCo } from "./config.ts";
import { memoryStores, type Stores } from "./stores.ts";
import { dynamoStores, ensureTable } from "./stores/dynamo.ts";

/** DynamoDB when DYNAMODB_TABLE is set (creating the table first for DynamoDB Local), else memory. */
export async function storesFromEnv(env: Record<string, string | undefined> = process.env): Promise<Stores> {
  if (!env.DYNAMODB_TABLE) return memoryStores();
  const o = { table: env.DYNAMODB_TABLE, ...(env.DYNAMODB_ENDPOINT ? { endpoint: env.DYNAMODB_ENDPOINT } : {}) };
  if (o.endpoint) await ensureTable(o);
  return dynamoStores(o);
}

export async function startCompany(opts: { port?: number; baseUrl?: string } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const baseUrl = opts.baseUrl ?? process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
  const company = createCompany({
    ...tippingCo(baseUrl, devAllowHttpLocalhost()),
    requireDpopNonce: process.env.POPPY_REQUIRE_DPOP_NONCE === "1",
    log: createLogger("company", processSink()),
  }, { stores: await storesFromEnv() });
  const server = serve({ fetch: company.app.fetch, port });
  console.log(`[company] ${company.config.name} listening on :${port} as ${company.config.issuer}`
    + (process.env.DYNAMODB_TABLE ? ` (DynamoDB table ${process.env.DYNAMODB_TABLE})` : " (in-memory stores)"));
  return { company, server };
}

if (import.meta.main) await startCompany();
