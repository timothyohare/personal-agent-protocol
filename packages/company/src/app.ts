import { Hono } from "hono";
import { publicApi } from "./api/public.ts";
import { authorizeRoutes } from "./authorize.ts";
import { requireSessionToken, type AuthEnv } from "./middleware.ts";
import { openApi } from "./openapi.ts";
import { resolveConfig, type CompanyConfig, type ResolvedConfig } from "./config.ts";
import { NonceManager, RateLimiter } from "./limits.ts";
import { memoryStores, type Stores } from "./stores.ts";
import { tokenRoutes } from "./token.ts";
import { createAgentVerifier } from "./verifyAgent.ts";
import { wellKnownRoutes } from "./wellknown.ts";

export interface Company {
  app: Hono;
  config: ResolvedConfig;
  stores: Stores;
}

export interface CompanyOptions {
  stores?: Stores;
  /** Token-endpoint requests per minute per client IP. */
  tokenRateLimit?: number;
  /** Password attempts per minute per sign-in request. */
  loginRateLimit?: number;
}

export function createCompany(config: CompanyConfig, opts: CompanyOptions = {}): Company {
  const c = resolveConfig(config);
  const stores = opts.stores ?? memoryStores();
  const deps = {
    c, stores,
    verifyAgent: createAgentVerifier(c),
    nonces: new NonceManager(c.requireDpopNonce),
    limiter: new RateLimiter(opts.tokenRateLimit ?? 120),
  };
  const app = new Hono();
  app.route("/", wellKnownRoutes(c));
  app.route("/", authorizeRoutes({ ...deps, loginLimiter: new RateLimiter(opts.loginRateLimit ?? 10) }));
  app.route("/", tokenRoutes(deps));
  app.get("/openapi.json", (ctx) => ctx.json(openApi(c)));

  const api = new Hono<AuthEnv>();
  api.use("/api/*", requireSessionToken(c, stores, deps.nonces));
  api.route("/", publicApi());
  app.route("/", api);
  return { app, config: c, stores };
}
