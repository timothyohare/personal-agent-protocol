import { Hono } from "hono";
import { meApi } from "./api/me.ts";
import { publicApi } from "./api/public.ts";
import { conversationRoutes } from "./conversations/routes.ts";
import { ConversationService, type CompanyAgent } from "./conversations/service.ts";
import { memoryConversationStores, type ConversationStores } from "./conversations/store.ts";
import { authorizeRoutes } from "./authorize.ts";
import { requireSessionToken, type AuthEnv } from "./middleware.ts";
import { openApi } from "./openapi.ts";
import { resolveConfig, type CompanyConfig, type ResolvedConfig } from "./config.ts";
import { NonceManager, RateLimiter } from "./limits.ts";
import { memoryStores, type Stores } from "./stores.ts";
import { authorizationCodeGrant, refreshTokenGrant } from "./grants.ts";
import { revokeRoutes } from "./revoke.ts";
import { tokenRoutes } from "./token.ts";
import { createAgentVerifier } from "./verifyAgent.ts";
import { wellKnownRoutes } from "./wellknown.ts";

export interface Company {
  app: Hono;
  config: ResolvedConfig;
  stores: Stores;
  conversations: ConversationService;
}

export interface CompanyOptions {
  stores?: Stores;
  /** Token-endpoint requests per minute per client IP. */
  tokenRateLimit?: number;
  /** Password attempts per minute per sign-in request. */
  loginRateLimit?: number;
  conversationStores?: ConversationStores;
  /** The company agent behind the conversation API (default: a scripted echo). */
  companyAgent?: CompanyAgent;
  /** How company-agent jobs run (default: in-process, straight away). */
  scheduleAgent?: (job: () => Promise<void>) => void;
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
  app.route("/", tokenRoutes(deps, {
    authorization_code: authorizationCodeGrant(deps),
    refresh_token: refreshTokenGrant(deps),
  }));
  app.route("/", revokeRoutes(deps));
  app.get("/openapi.json", (ctx) => ctx.json(openApi(c)));

  const api = new Hono<AuthEnv>();
  api.use("/api/*", requireSessionToken(c, stores, deps.nonces));
  api.use("/conversations", requireSessionToken(c, stores, deps.nonces));
  api.use("/conversations/*", requireSessionToken(c, stores, deps.nonces));
  api.route("/", publicApi());
  api.route("/", meApi(stores));
  const conversations = new ConversationService(opts.conversationStores ?? memoryConversationStores(),
    { log: c.log, ...(opts.companyAgent ? { agent: opts.companyAgent } : {}),
      ...(opts.scheduleAgent ? { schedule: opts.scheduleAgent } : {}) });
  api.route("/", conversationRoutes(conversations));
  app.route("/", api);
  return { app, config: c, stores, conversations };
}
