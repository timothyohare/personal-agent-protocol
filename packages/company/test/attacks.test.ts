// The attack suite, in-process. The same attacks run live with `npm run attacks`.
import { describe, expect, test } from "vitest";
import { ATTACKS, type AttackContext, type Served } from "../../../test-support/attacks.ts";
import { COMPANY, COMPANY_HOST, testbed } from "../../../test-support/testbed.ts";

let n = 0;

async function context(): Promise<AttackContext> {
  const tb = await testbed({ company: {
    // Only 127.0.0.1 and private literals are internal here; every named host resolves publicly.
    resolveHost: async () => ["93.184.216.34"],
  } });
  const attacker = await tb.addAgent("attacker.example", "Mallory's Agent");
  const serve = (host: string, docs: Record<string, unknown>): Served => {
    let hits = 0;
    tb.hosts[host] = { fetch: (r) => {
      hits++;
      const body = docs[new URL(r.url).pathname];
      return body === undefined ? new Response("not found", { status: 404 }) : Response.json(body);
    } };
    return { origin: `https://${host}`, hits: () => hits, close: () => { delete tb.hosts[host]; } };
  };
  return {
    fetch: tb.fetch, company: COMPANY_HOST, base: COMPANY, allowHttpLocalhost: false,
    agent: tb.agent, attacker,
    secondUser: { username: "rival", password: "battery staple horse correct" },
    serveDocs: async (docs) => {
      const host = `docs-${++n}.example`;
      return serve(host, docs(`https://${host}`));
    },
    internalTarget: async () => {
      const s = serve("127.0.0.1", { "/agent.json": {} });
      return { ...s, clientId: "https://127.0.0.1/agent.json" };
    },
  };
}

describe("attack suite (SecurityReview section 5)", () => {
  for (const a of ATTACKS) {
    test(`${a.id}: ${a.title} → ${a.expected}`, async () => {
      const o = await a.run(await context());
      expect(o, o.observed).toMatchObject({ pass: true });
    });
  }
});
