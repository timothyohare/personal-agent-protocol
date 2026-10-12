import { Hono } from "hono";
import { resolveConfig, type CompanyConfig, type ResolvedConfig } from "./config.ts";
import { wellKnownRoutes } from "./wellknown.ts";

export interface Company {
  app: Hono;
  config: ResolvedConfig;
}

export function createCompany(config: CompanyConfig): Company {
  const c = resolveConfig(config);
  const app = new Hono();
  app.route("/", wellKnownRoutes(c));
  return { app, config: c };
}
