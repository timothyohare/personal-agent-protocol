// Runs the attack suite against the booted services (npm run dev:local) and prints a pass/fail table.
// Exits non-zero if any attack succeeds. Usage: npm run attacks [-- A-01 A-05 ...]
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadIdentity } from "agent";
import { runAttacks, table, type AttackContext, type Served } from "../test-support/attacks.ts";
import { keysDir, readPrivateJwk } from "./keys.ts";

const COMPANY = process.env.POPPY_COMPANY ?? "localhost:8787";
const AGENT = process.env.AGENT_BASE_URL ?? "http://localhost:8788";
const ATTACKER = process.env.ATTACKER_BASE_URL ?? "http://localhost:8789";

async function listen(handler: (path: string) => unknown): Promise<Served & { port: number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    const body = handler(new URL(req.url ?? "/", "http://x").pathname);
    if (body === undefined) res.writeHead(404).end();
    else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { port, origin: `http://localhost:${port}`, hits: () => hits, close: () => server.close() };
}

const agentId = `${AGENT}/agent.json`;
const attackerId = `${ATTACKER}/agent.json`;
const ctx: AttackContext = {
  fetch, company: COMPANY, base: `http://${COMPANY}`, allowHttpLocalhost: true,
  agent: { clientId: agentId, identity: await loadIdentity(agentId, readPrivateJwk(keysDir(), "agent")) },
  attacker: { clientId: attackerId, identity: await loadIdentity(attackerId, readPrivateJwk(keysDir(), "attacker")) },
  secondUser: { username: "rival", password: "battery staple horse correct" },
  serveDocs: async (docs) => {
    let all: Record<string, unknown> = {};
    const s = await listen((p) => all[p]);
    all = docs(s.origin);
    return s;
  },
  internalTarget: async () => {
    const s = await listen(() => ({}));
    // https to a loopback literal: the dev exception covers http://localhost only, so this must be blocked.
    return { ...s, clientId: `https://127.0.0.1:${s.port}/agent.json` };
  },
};

const results = await runAttacks(ctx, process.argv.slice(2));
console.log(table(results));
process.exit(results.every((r) => r.pass) ? 0 : 1);
