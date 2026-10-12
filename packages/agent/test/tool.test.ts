import { describe, expect, test } from "vitest";
import { MemoryVault, PoppyAgent, isWrite, poppyCall } from "../src/index.ts";
import { COMPANY_HOST, testbed } from "../../../test-support/testbed.ts";
import { TestBrowser, userSignsIn } from "../../../test-support/browser.ts";
import { leaks } from "../../../test-support/leaks.ts";

async function setup(o: { declineSignIn?: boolean } = {}) {
  const tb = await testbed();
  const vault = new MemoryVault();
  const agent = new PoppyAgent({ identity: tb.agent.identity, vault, fetch: tb.fetch, sleep: async () => {} });
  const shownToUser: string[] = [];
  const signIn = async (company: string, scopes: string[]) => {
    if (o.declineSignIn) return false;
    const c = agent.company(company);
    const url = await c.beginSignIn(scopes);
    shownToUser.push(url);
    await c.completeSignIn(await userSignsIn(new TestBrowser(tb.fetch), url));
    return true;
  };
  return { tb, vault, agent, deps: { agent, signIn }, shownToUser };
}

describe("poppy_call", () => {
  test("public data with a signed-out Session", async () => {
    const { deps } = await setup();
    const out = JSON.parse(await poppyCall({ company: COMPANY_HOST, method: "get", path: "/api/fixtures" }, deps));
    expect(out).toMatchObject({ status: 200, body: { round: 27 } });
  });

  test("sign_in_required: the user signs in (the model only sees the result), then the call is retried", async () => {
    const { deps, shownToUser } = await setup();
    const out = JSON.parse(await poppyCall({ company: COMPANY_HOST, method: "POST", path: "/api/me/tips",
      body: { fixture_id: "r27-1", team: "Storm" } }, deps));
    expect(out).toMatchObject({ status: 201, body: { team: "Storm" } });
    expect(shownToUser).toHaveLength(1);
  });

  test("the user declining sign-in is reported as sign_in_required", async () => {
    const { deps } = await setup({ declineSignIn: true });
    expect(JSON.parse(await poppyCall({ company: COMPANY_HOST, method: "GET", path: "/api/me/tips" }, deps)))
      .toEqual({ status: 403, error: "sign_in_required", detail: "the user did not sign in" });
  });

  test("errors come back as codes; bad paths and unknown companies don't throw", async () => {
    const { deps } = await setup();
    expect(JSON.parse(await poppyCall({ company: COMPANY_HOST, method: "GET", path: "https://evil.example/x" }, deps)).error)
      .toBe("invalid_path");
    expect(JSON.parse(await poppyCall({ company: "nowhere.example", method: "GET", path: "/api/x" }, deps)).error)
      .toBe("tool_error");
  });

  test("F12: no token, proof, key, code or session_id in any tool output", async () => {
    const { deps, agent, vault } = await setup();
    const outputs = [
      await poppyCall({ company: COMPANY_HOST, method: "GET", path: "/api/fixtures" }, deps),
      await poppyCall({ company: COMPANY_HOST, method: "POST", path: "/api/me/tips", body: { fixture_id: "r27-2", team: "Sharks" } }, deps),
      await poppyCall({ company: COMPANY_HOST, method: "GET", path: "/api/me/tips" }, deps),
      await poppyCall({ company: COMPANY_HOST, method: "GET", path: "/api/me/score" }, deps),
      await poppyCall({ company: COMPANY_HOST, method: "GET", path: "/api/nope" }, deps),
    ].join("\n");
    const c = agent.company(COMPANY_HOST);
    const secrets = [c.session!.token, c.session!.sessionId, (await c.accountToken())!.token,
      ...[...(await Promise.all(["dpop_key:https://tipping.example"].map((k) => vault.get(k))))].filter((x): x is string => !!x)];
    expect(leaks(outputs, secrets)).toEqual([]);
  });

  test("isWrite", () => {
    expect(["post", "PUT", "patch", "DELETE"].every(isWrite)).toBe(true);
    expect(["GET", "head", "OPTIONS"].some(isWrite)).toBe(false);
  });
});

test("PoppyAgent keeps a separate User ID and DPoP key per company (F29)", async () => {
  const { agent } = await setup();
  expect(agent.company("tipping.example")).toBe(agent.company("https://Tipping.example/"));
  expect(agent.company("tipping.example")).not.toBe(agent.company("stats.example"));
});
