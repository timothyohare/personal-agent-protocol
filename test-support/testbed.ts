// An in-process Tipping Co, agent host and agent identity, wired together through fetchRouter.
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from "jose";
import { createAgentHost } from "agent-host";
import { CompanyClient, MemoryVault, loadIdentity, type AgentDeps, type Vault } from "agent";
import { createCompany, tippingCo, type CompanyConfig, type CompanyOptions, type Table } from "company";
import { createLogger, fetchRouter, type Handler } from "poppy-core";

export const COMPANY_HOST = "tipping.example";
export const COMPANY = `https://${COMPANY_HOST}`;
export const TOKEN_EP = `${COMPANY}/oauth/token`;

/** Changes a stored record in tests (stores hand out copies, so this reads, edits and writes it back). */
export async function edit<T>(table: Table<T>, id: string, change: (v: T) => void): Promise<void> {
  const v = await table.get(id);
  if (v === undefined) throw new Error(`no record ${id}`);
  change(v);
  await table.put(id, v);
}

export async function agentKeys() {
  const kp = await generateKeyPair("ES256", { extractable: true });
  const pub = await exportJWK(kp.publicKey);
  const kid = (await calculateJwkThumbprint(pub)).slice(0, 16);
  return {
    publicJwk: { ...pub, kid, alg: "ES256" } as JWK,
    privateJwk: { ...(await exportJWK(kp.privateKey)), kid } as JWK,
  };
}

export interface TestbedOptions extends CompanyOptions {
  company?: Partial<CompanyConfig>;
}

export async function testbed(opts: TestbedOptions = {}) {
  const hosts: Record<string, Handler> = {};
  const fetch = fetchRouter(hosts);
  const logs: string[] = [];
  const log = createLogger("company", (l) => logs.push(l));
  const company = createCompany({
    ...tippingCo(COMPANY, false), fetch, log, resolveHost: async () => ["93.184.216.34"], ...opts.company,
  }, opts);
  hosts[COMPANY_HOST] = company.app;

  /** Adds an agent host at `host` and returns that agent's identity. */
  async function addAgent(host: string, name = "Test Agent") {
    const keys = await agentKeys();
    hosts[host] = createAgentHost({ baseUrl: `https://${host}`, clientName: name, publicJwks: [keys.publicJwk] });
    const clientId = `https://${host}/agent.json`;
    return { clientId, keys, identity: await loadIdentity(clientId, keys.privateJwk) };
  }

  const agent = await addAgent("agent.example");
  const sleeps: number[] = [];
  const client = (vault: Vault = new MemoryVault(), extra: Partial<AgentDeps> = {}, identity = agent.identity) =>
    new CompanyClient(COMPANY_HOST, {
      identity, vault, fetch, sleep: async (ms) => { sleeps.push(ms); }, ...extra,
    });

  return { hosts, fetch, company, agent, addAgent, client, logs, sleeps };
}
