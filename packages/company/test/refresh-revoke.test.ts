import { describe, expect, test } from "vitest";
import { clientAssertion, dpopProof, jwkThumbprint, newDpopKey } from "poppy-core";
import { MemoryVault, dpopKeyFor } from "agent";
import { CLIENT_ASSERTION_TYPE } from "../src/index.ts";
import { COMPANY, TOKEN_EP, testbed } from "../../../test-support/testbed.ts";
import { signInFlow } from "../../../test-support/signin.ts";

async function setup(opts: Parameters<typeof testbed>[0] = {}) {
  const tb = await testbed(opts);
  const vault = new MemoryVault();
  const client = tb.client(vault);
  const { session } = await signInFlow(client, tb.fetch);
  const at = (await client.accountToken())!.token;
  type Agent = Awaited<ReturnType<typeof tb.addAgent>>;
  const raw = async (url: string, form: Record<string, string>, agent: Agent | typeof tb.agent = tb.agent,
    dpop?: Awaited<ReturnType<typeof newDpopKey>>) => {
    const body = new URLSearchParams({ client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(agent.clientId, TOKEN_EP, agent.identity.signingKey), ...form });
    const res = await tb.fetch(url, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded",
      ...(url === TOKEN_EP ? { dpop: await dpopProof(dpop ?? await newDpopKey(), "POST", TOKEN_EP) } : {}) } });
    return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
  };
  const refresh = (form: Record<string, string> = {}, agent?: Parameters<typeof raw>[2], dpop?: Parameters<typeof raw>[3]) =>
    raw(TOKEN_EP, { grant_type: "refresh_token", refresh_token: at, ...form }, agent, dpop);
  const revoke = (form: Record<string, string> = {}, agent?: Parameters<typeof raw>[2]) =>
    raw(`${COMPANY}/oauth/revoke`, { token: at, token_type_hint: "refresh_token", ...form }, agent);
  return { tb, vault, client, session, at, refresh, revoke, raw };
}

describe("refresh_token grant (F10)", () => {
  test("without session_id: a new signed-in Session", async () => {
    const { refresh, session, tb } = await setup();
    const r = await refresh();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ signed_in: true, scope: "poppy:read poppy:write standings", token_type: "DPoP" });
    expect(r.json.session_id).not.toBe(session.sessionId);
    expect(r.json).not.toHaveProperty("refresh_token");
    expect((await tb.company.stores.sessions.get(r.json.session_id as string))).toMatchObject({ accountId: "acct_tipper" });
  });

  test("with a session_id that belongs to another User ID: invalid_session", async () => {
    const { refresh, tb } = await setup();
    // A fresh vault means a different random User ID for the same agent.
    const s2 = await tb.client(new MemoryVault()).startSession();
    expect((await refresh({ session_id: s2.sessionId })).json.error).toBe("invalid_session");
  });

  test("with our own session_id: same Session, signed in", async () => {
    const { client, refresh } = await setup();
    const renewed = await client.startSession({ renew: true });
    const r = await refresh({ session_id: renewed.sessionId });
    expect(r.json).toMatchObject({ session_id: renewed.sessionId, signed_in: true });
  });

  test("S4 E1: refresh with a new DPoP key succeeds, and the token is bound to the new key", async () => {
    const { refresh, tb } = await setup();
    const k = await newDpopKey();
    const r = await refresh({}, undefined, k);
    expect(r.status).toBe(200);
    expect((await tb.company.stores.tokens.get(r.json.access_token as string))!.jkt).toBe(await jwkThumbprint(k.publicJwk));
  });

  test("A-20: refresh with the Account Token from a different client_id is invalid_grant", async () => {
    const { refresh, tb } = await setup();
    const thief = await tb.addAgent("thief.example");
    expect(await refresh({}, thief)).toMatchObject({ status: 400, json: { error: "invalid_grant" } });
  });

  test("an unknown Account Token is invalid_grant", async () => {
    const { refresh } = await setup();
    expect((await refresh({ refresh_token: "nope" })).json.error).toBe("invalid_grant");
  });

  test("scope can narrow, never widen (S4 G8)", async () => {
    const { refresh, tb } = await setup();
    const narrow = await refresh({ scope: "poppy:read" });
    expect(narrow.json.scope).toBe("poppy:read");
    expect((await tb.company.stores.tokens.get(narrow.json.access_token as string))!.scope).toEqual(["poppy:read"]);
    expect((await refresh({ scope: "poppy:read admin" })).json.error).toBe("invalid_scope");
    expect((await refresh({ scope: "" })).json.error).toBe("invalid_scope");
  });

  test("A-43: refreshing into a Session signed in to a different account is account_mismatch", async () => {
    const { tb, client, refresh } = await setup();
    const { makeUser } = await import("../src/index.ts");
    await tb.company.stores.users.put("other", makeUser("other", "pw"));
    // The same agent and User ID signs a second Session in to another account...
    const s2 = await client.startSession();
    const { TestBrowser, userSignsIn } = await import("../../../test-support/browser.ts");
    const url = await client.beginSignIn(["poppy:read"]);
    await client.completeSignIn(await userSignsIn(new TestBrowser(tb.fetch), url, { username: "other", password: "pw" }))
      .catch(() => {});
    // completeSignIn replaced the vault token with the other account's; use the first account's token directly.
    expect((await tb.company.stores.sessions.get(s2.sessionId))!.accountId).toBe("acct_other");
    expect(await refresh({ session_id: s2.sessionId })).toMatchObject({ status: 400, json: { error: "account_mismatch" } });
  });

  test("rotation: the agent stores and uses the new Account Token (S4 G9)", async () => {
    const tb = await testbed({ company: { rotateAccountTokens: true } });
    const client = tb.client();
    await signInFlow(client, tb.fetch);
    const first = (await client.accountToken())!.token;
    await client.resume();
    const second = (await client.accountToken())!.token;
    expect(second).not.toBe(first);
    expect(((await tb.company.stores.accountTokens.get(first)) !== undefined)).toBe(false);
    await client.resume();
    expect((await client.accountToken())!.token).not.toBe(second);
  });
});

describe("revocation (spec 4.9, F11)", () => {
  test("A-08: after revocation the old signed-in token gets 403 sign_in_required and refresh fails", async () => {
    const { tb, client, session, refresh, revoke } = await setup();
    expect((await revoke()).status).toBe(200);
    const st = (await tb.company.stores.tokens.get(session.token))!;
    expect((await tb.company.stores.sessions.get(st.sessionId))!.accountId).toBeNull();
    // The agent still holds the revoked Account Token, tries it once, gets invalid_grant and gives up.
    const r = await client.call("GET", "/api/me/tips");
    expect(r).toMatchObject({ status: 403, error: "sign_in_required" });
    expect(await refresh()).toMatchObject({ status: 400, json: { error: "invalid_grant" } });
    // The agent dropped the Account Token after invalid_grant.
    expect(await client.accountToken()).toBeUndefined();
    // The Session carries on signed out.
    expect((await client.call("GET", "/api/fixtures")).status).toBe(200);
  });

  test("revocation needs the client assertion", async () => {
    const { tb, at } = await setup();
    const res = await tb.fetch(`${COMPANY}/oauth/revoke`, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: at }) });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe("invalid_client");
  });

  test("A-46: revoking from another agent is refused, and the token stays valid", async () => {
    const { tb, revoke, refresh } = await setup();
    const other = await tb.addAgent("other.example");
    expect((await revoke({}, other)).status).toBe(400);
    expect((await refresh()).status).toBe(200);
  });

  test("an unknown token is a 200 (RFC 7009); a missing token is invalid_request", async () => {
    const { revoke } = await setup();
    expect((await revoke({ token: "unknown" })).status).toBe(200);
    expect((await revoke({ token: "" })).json.error).toBe("invalid_request");
  });

  test("revoking signs out every Session signed in with that Account Token", async () => {
    const { tb, client, revoke } = await setup();
    const resumed = await client.resume();
    await revoke();
    for (const id of [resumed.sessionId]) expect((await tb.company.stores.sessions.get(id))!.accountId).toBeNull();
  });

  test("a Session Token can be revoked by its own agent", async () => {
    const { session, revoke, tb } = await setup();
    expect((await revoke({ token: session.token, token_type_hint: "access_token" })).status).toBe(200);
    expect(((await tb.company.stores.tokens.get(session.token)) !== undefined)).toBe(false);
  });
});

describe("agent resume and sign-out (milestone 4)", () => {
  test("kill → resume: a new process with the same vault is signed in without asking the user", async () => {
    const { tb, vault, client } = await setup();
    await client.call("POST", "/api/me/tips", { fixture_id: "r27-1", team: "Storm" });
    const restarted = tb.client(vault);
    const r = await restarted.call("GET", "/api/me/tips");
    expect(r.status).toBe(200);
    expect((r.body as { tips: unknown[] }).tips).toHaveLength(1);
    expect(restarted.session!.signedIn).toBe(true);
  });

  test("signout → 403, and the vault no longer holds the Account Token", async () => {
    const { tb, vault, client } = await setup();
    expect(await client.signOut()).toBe(true);
    expect(await client.accountToken()).toBeUndefined();
    expect((await client.call("GET", "/api/me/tips")).error).toBe("sign_in_required");
    expect((await tb.client(vault).call("GET", "/api/me/tips")).error).toBe("sign_in_required");
    expect(await client.signOut()).toBe(false);
  });

  test("the resumed token is bound to the agent's per-company DPoP key", async () => {
    const { tb, vault } = await setup();
    const c = tb.client(vault);
    const s = await c.resume();
    expect((await tb.company.stores.tokens.get(s.token))!.jkt).toBe(await jwkThumbprint((await dpopKeyFor(vault, COMPANY)).publicJwk));
  });
});
