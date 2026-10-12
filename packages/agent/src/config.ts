// Agent configuration from the environment, for the CLI and scripts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JWK } from "jose";
import { createLogger, devAllowHttpLocalhost, type Logger } from "poppy-core";
import { CompanyClient } from "./company.ts";
import { loadIdentity } from "./identity.ts";
import { FileVault } from "./vault.ts";

export interface AgentEnvConfig {
  company: string;
  agentBaseUrl: string;
  keysDir: string;
  vaultPath: string;
  vaultKeyPath: string;
  allowHttpLocalhost: boolean;
}

export function agentConfigFromEnv(env: Record<string, string | undefined> = process.env): AgentEnvConfig {
  return {
    company: env.POPPY_COMPANY ?? "localhost:8787",
    agentBaseUrl: env.AGENT_BASE_URL ?? "http://localhost:8788",
    keysDir: resolve(env.POPPY_KEYS_DIR ?? "keys"),
    vaultPath: resolve(env.POPPY_VAULT ?? ".vault/vault.json"),
    vaultKeyPath: resolve(env.POPPY_VAULT_KEY ?? ".vault/vault.key"),
    allowHttpLocalhost: devAllowHttpLocalhost(env),
  };
}

export async function clientFromConfig(cfg: AgentEnvConfig, log: Logger = createLogger("agent", console.error)) {
  const privateJwk = JSON.parse(readFileSync(resolve(cfg.keysDir, "agent-signing.private.json"), "utf8")) as JWK;
  const identity = await loadIdentity(`${new URL(cfg.agentBaseUrl).origin}/agent.json`, privateJwk);
  return new CompanyClient(cfg.company, {
    identity, vault: new FileVault(cfg.vaultPath, cfg.vaultKeyPath), allowHttpLocalhost: cfg.allowHttpLocalhost, log,
  });
}
