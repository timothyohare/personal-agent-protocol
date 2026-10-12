// Drives one full Direct Sign-In lifecycle, including the main refusals, so tests can check the
// company's narrated log lines (N6) end to end.
import { MemoryVault } from "agent";
import { pkceChallenge, pkceVerifier } from "poppy-core";
import { COMPANY, testbed } from "./testbed.ts";
import { TestBrowser, parseForm } from "./browser.ts";
import { signInFlow } from "./signin.ts";

/** Replaces random ids so log lines can be compared exactly. */
export const normalise = (line: string): string => line
  .replace(/ses_[A-Za-z0-9_-]{22}/g, "ses_*").replace(/u_[A-Za-z0-9_-]{22}/g, "u_*");

export async function narratedFlow() {
  const tb = await testbed();
  const client = tb.client(new MemoryVault());
  const b = new TestBrowser(tb.fetch);
  const authz = (over: Record<string, string>) => {
    const u = new URL(`${COMPANY}/oauth/authorize`);
    u.search = new URLSearchParams({ response_type: "code", client_id: tb.agent.clientId,
      redirect_uri: "https://agent.example/oauth/callback", scope: "poppy:read", state: "s",
      code_challenge: pkceChallenge(pkceVerifier()), code_challenge_method: "S256", ...over }).toString();
    return u.toString();
  };
  await client.startSession();
  await client.startSession({ renew: true });
  await b.get(authz({ client_id: "https://nobody.example/agent.json" }));
  await b.get(authz({ redirect_uri: "https://evil.example/cb" }));
  await b.get(authz({ code_challenge_method: "plain" }));
  await b.get(authz({ scope: "admin" }));
  // A failed login, then a declined consent.
  const f = parseForm(await (await b.get(authz({}))).text());
  await b.post(`${COMPANY}/oauth/authorize/login`, [["req", f.hidden.req!], ["csrf", f.hidden.csrf!], ["username", "tipper"], ["password", "x"]]);
  await b.post(`${COMPANY}/oauth/authorize/login`, [["req", f.hidden.req!], ["csrf", f.hidden.csrf!], ["username", "tipper"],
    ["password", "correct horse battery staple"]]);
  await b.post(`${COMPANY}/oauth/authorize/consent`, [["req", f.hidden.req!], ["csrf", f.hidden.csrf!], ["decision", "deny"]]);
  await signInFlow(client, tb.fetch, { scopes: ["poppy:read", "standings"] });
  await client.resume();
  await client.call("GET", "/api/fixtures");
  await tb.fetch(`${COMPANY}/api/fixtures`, { headers: { authorization: `DPoP ${client.session!.token}` } });
  await client.signOut();
  await tb.fetch(`${COMPANY}/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await tb.fetch(`${COMPANY}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "token=x" });
  return tb.logs.map(normalise);
}
