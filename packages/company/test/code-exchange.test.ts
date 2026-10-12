import { describe, expect, test } from "vitest";
import { clientAssertion, dpopProof, jwkThumbprint, newDpopKey, pkceChallenge, pkceVerifier, type DpopKey } from "poppy-core";
import { MemoryVault } from "agent";
import { CLIENT_ASSERTION_TYPE } from "../src/index.ts";
import { COMPANY, TOKEN_EP, edit, testbed } from "../../../test-support/testbed.ts";
import { TestBrowser, userSignsIn } from "../../../test-support/browser.ts";
import { signInFlow } from "../../../test-support/signin.ts";

const CB = "https://agent.example/oauth/callback";

/** Gets a fresh code for the test agent, and a signed-out Session to exchange it into. */
async function setup() {
  const tb = await testbed();
  const client = tb.client(new MemoryVault());
  const s = await client.startSession();
  const verifier = pkceVerifier();
  const newCode = async (scope = "poppy:read poppy:write") => {
    const u = new URL(`${COMPANY}/oauth/authorize`);
    u.search = new URLSearchParams({ response_type: "code", client_id: tb.agent.clientId, redirect_uri: CB, scope,
      state: "st", code_challenge: pkceChallenge(verifier), code_challenge_method: "S256" }).toString();
    return new URL(await userSignsIn(new TestBrowser(tb.fetch), u.toString())).searchParams.get("code")!;
  };
  const exchange = async (form: Record<string, string>, o: { agent?: Awaited<ReturnType<typeof tb.addAgent>>;
    dpop?: DpopKey } = {}) => {
    const id = o.agent ?? tb.agent;
    const body = new URLSearchParams({ grant_type: "authorization_code", redirect_uri: CB, code_verifier: verifier,
      session_id: s.sessionId, client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(id.clientId, TOKEN_EP, id.identity.signingKey), ...form });
    const res = await tb.fetch(TOKEN_EP, { method: "POST", body, headers: {
      "content-type": "application/x-www-form-urlencoded",
      dpop: await dpopProof(o.dpop ?? await newDpopKey(), "POST", TOKEN_EP) } });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };
  return { tb, client, s, verifier, newCode, exchange };
}

describe("authorization_code grant", () => {
  test("returns a signed-in token for that Session plus an Account Token", async () => {
    const { exchange, newCode, s } = await setup();
    const r = await exchange({ code: await newCode() });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ token_type: "DPoP", signed_in: true, session_id: s.sessionId,
      scope: "poppy:read poppy:write", expires_in: 3600 });
    expect(r.json.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("the new token is bound to the key in the exchange request's proof (S4 E1)", async () => {
    const { exchange, newCode, tb } = await setup();
    const k = await newDpopKey();
    const r = await exchange({ code: await newCode() }, { dpop: k });
    expect((await tb.company.stores.tokens.get(r.json.access_token as string))!.jkt).toBe(await jwkThumbprint(k.publicJwk));
  });

  test("A-12: a code works once only; the first sign-in stays valid", async () => {
    const { exchange, newCode, tb } = await setup();
    const code = await newCode();
    const first = await exchange({ code });
    expect(first.status).toBe(200);
    expect((await exchange({ code })).json.error).toBe("invalid_grant");
    expect((await tb.company.stores.tokens.get(first.json.access_token as string))).toBeDefined();
  });

  test("A-13: the wrong PKCE verifier (and the code is burned)", async () => {
    const { exchange, newCode } = await setup();
    const code = await newCode();
    expect(await exchange({ code, code_verifier: pkceVerifier() })).toMatchObject({ status: 400, json: { error: "invalid_grant" } });
    expect((await exchange({ code })).json.error).toBe("invalid_grant");
    expect((await exchange({ code: await newCode(), code_verifier: "" })).json.error).toBe("invalid_grant");
  });

  test("a different redirect_uri, an unknown code or an expired code", async () => {
    const { exchange, newCode, tb } = await setup();
    expect((await exchange({ code: await newCode(), redirect_uri: "https://agent.example/other" })).json.error).toBe("invalid_grant");
    expect((await exchange({ code: "nope" })).json.error).toBe("invalid_grant");
    const code = await newCode();
    await edit(tb.company.stores.codes, code, (c) => { c.expiresAt = Date.now() - 1; });
    expect((await exchange({ code })).json.error).toBe("invalid_grant");
  });

  test("a code issued to another client", async () => {
    const { exchange, newCode, tb } = await setup();
    const other = await tb.addAgent("other.example");
    const code = await newCode();
    expect((await exchange({ code }, { agent: other })).json.error).toBe("invalid_grant");
  });

  test("A-04: another agent's session_id gives invalid_session", async () => {
    const { tb, exchange } = await setup();
    // The other agent gets its own code, then tries to use our Session.
    const other = await tb.addAgent("other.example");
    const victim = await tb.client().startSession();
    const otherClient = tb.client(new MemoryVault(), {}, other.identity);
    await otherClient.startSession();
    const verifier = pkceVerifier();
    const u = new URL(`${COMPANY}/oauth/authorize`);
    u.search = new URLSearchParams({ response_type: "code", client_id: other.clientId,
      redirect_uri: "https://other.example/oauth/callback", scope: "poppy:read", state: "st",
      code_challenge: pkceChallenge(verifier), code_challenge_method: "S256" }).toString();
    const code = new URL(await userSignsIn(new TestBrowser(tb.fetch), u.toString())).searchParams.get("code")!;
    const r = await exchange({ code, code_verifier: verifier, session_id: victim.sessionId,
      redirect_uri: "https://other.example/oauth/callback" }, { agent: other });
    expect(r).toMatchObject({ status: 400, json: { error: "invalid_session" } });
  });

  test("a missing session_id", async () => {
    const { exchange, newCode } = await setup();
    expect((await exchange({ code: await newCode(), session_id: "" })).json.error).toBe("invalid_request");
  });

  test("account_mismatch when the Session is signed in to another account (A-43 shape)", async () => {
    const { tb, client } = await setup();
    await signInFlow(client, tb.fetch);
    const { makeUser } = await import("../src/index.ts");
    await tb.company.stores.users.put("other", makeUser("other", "pw-other"));
    const url = await client.beginSignIn(["poppy:read"]);
    const cb = await userSignsIn(new TestBrowser(tb.fetch), url, { username: "other", password: "pw-other" });
    await expect(client.completeSignIn(cb)).rejects.toMatchObject({ code: "account_mismatch", status: 400 });
  });

  test("A-40: 20 parallel exchanges of one code produce exactly one success", async () => {
    const { exchange, newCode } = await setup();
    const code = await newCode();
    const results = await Promise.all(Array.from({ length: 20 }, () => exchange({ code })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });
});
