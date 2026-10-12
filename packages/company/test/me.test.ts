import { describe, expect, test } from "vitest";
import { MemoryVault } from "agent";
import { testbed } from "../../../test-support/testbed.ts";
import { signInFlow } from "../../../test-support/signin.ts";

async function signedIn(o: { untick?: string[] } = {}) {
  const tb = await testbed();
  const client = tb.client(new MemoryVault());
  await signInFlow(client, tb.fetch, o);
  return { tb, client };
}

describe("signed out (F6)", () => {
  test("every /api/me route is 403 sign_in_required with WWW-Authenticate and the scope", async () => {
    const tb = await testbed();
    const client = tb.client();
    for (const [m, p, scope] of [["GET", "/api/me/tips", "poppy:read"], ["POST", "/api/me/tips", "poppy:write"],
      ["GET", "/api/me/score", "standings"]] as const) {
      const r = await client.call(m, p, m === "POST" ? { fixture_id: "r27-1", team: "Storm" } : undefined);
      expect(r).toMatchObject({ status: 403, error: "sign_in_required", requiredScope: scope });
    }
  });
});

describe("signed in", () => {
  test("POST a tip, then GET shows it; a second tip for the fixture replaces it", async () => {
    const { client } = await signedIn();
    const post = await client.call("POST", "/api/me/tips", { fixture_id: "r27-1", team: "storm" });
    expect(post.status).toBe(201);
    expect(post.body).toMatchObject({ fixture_id: "r27-1", round: 27, team: "Storm" });
    await client.call("POST", "/api/me/tips", { fixture_id: "r27-2", team: "Sharks" });
    await client.call("POST", "/api/me/tips", { fixture_id: "r27-1", team: "Broncos" });
    const get = await client.call("GET", "/api/me/tips");
    expect((get.body as { tips: { fixture_id: string; team: string }[] }).tips.map((t) => [t.fixture_id, t.team]))
      .toEqual([["r27-1", "Broncos"], ["r27-2", "Sharks"]]);
  });

  test("tips are validated: known fixture, a team in it, the right shape", async () => {
    const { client } = await signedIn();
    for (const body of [{ fixture_id: "nope", team: "Storm" }, { fixture_id: "r27-1", team: "Sharks" },
      { fixture_id: "r27-1" }, "not json", null]) {
      const r = await client.call("POST", "/api/me/tips", body);
      expect(r).toMatchObject({ status: 400, error: "invalid_tip" });
    }
  });

  test("tips are per account", async () => {
    const { tb, client } = await signedIn();
    await client.call("POST", "/api/me/tips", { fixture_id: "r27-1", team: "Storm" });
    const { makeUser } = await import("../src/index.ts");
    await tb.company.stores.users.put("other", makeUser("other", "pw"));
    const c2 = tb.client(new MemoryVault());
    await signInFlow(c2, tb.fetch, { username: "other", password: "pw" });
    expect((await c2.call("GET", "/api/me/tips")).body).toEqual({ tips: [] });
  });

  test("GET /api/me/score with the custom standings scope", async () => {
    const { client } = await signedIn();
    expect((await client.call("GET", "/api/me/score")).body).toMatchObject({ position: 37, tipped: 208 });
  });

  test("A-23: an unticked scope gives 403 insufficient_scope with scope= in WWW-Authenticate", async () => {
    const { client } = await signedIn({ untick: ["poppy:write"] });
    expect((await client.call("GET", "/api/me/tips")).status).toBe(200);
    expect(await client.call("POST", "/api/me/tips", { fixture_id: "r27-1", team: "Storm" }))
      .toMatchObject({ status: 403, error: "insufficient_scope", requiredScope: "poppy:write" });
  });

  test("a renewal by assertion gives a signed-out token; the agent then signs it in with its Account Token", async () => {
    const { client, tb } = await signedIn();
    const renewed = await client.startSession({ renew: true });
    const { currentAuth } = await import("../src/index.ts");
    const st = (await tb.company.stores.tokens.get(renewed.token))!;
    expect(currentAuth(st, (await tb.company.stores.sessions.get(st.sessionId))!).signedIn).toBe(false);
    expect((await client.call("GET", "/api/me/tips")).status).toBe(200);
    expect(client.session!.signedIn).toBe(true);
    expect(client.session!.sessionId).toBe(renewed.sessionId);
  });
});
