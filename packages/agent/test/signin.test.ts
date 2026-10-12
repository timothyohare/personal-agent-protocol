import { describe, expect, test } from "vitest";
import { jwkThumbprint, PoppyError } from "poppy-core";
import { MemoryVault, dpopKeyFor } from "../src/index.ts";
import { COMPANY, testbed } from "../../../test-support/testbed.ts";
import { TestBrowser, userSignsIn } from "../../../test-support/browser.ts";
import { ALL_SCOPES, signInFlow } from "../../../test-support/signin.ts";

async function setup() {
  const tb = await testbed();
  const vault = new MemoryVault();
  const client = tb.client(vault);
  let tokenPosts = 0;
  const real = tb.hosts["tipping.example"]!;
  tb.hosts["tipping.example"] = { fetch: (r) => {
    if (r.method === "POST" && r.url.endsWith("/oauth/token")) tokenPosts++;
    return real.fetch(r);
  } };
  return { tb, vault, client, tokenPosts: () => tokenPosts };
}

async function rejectsWith(p: Promise<unknown>, code: string) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(PoppyError);
  expect((e as PoppyError).code).toBe(code);
}

describe("Direct Sign-In, end to end", () => {
  test("signs in the current Session and stores the Account Token in the vault", async () => {
    const { tb, client, vault } = await setup();
    const before = await client.startSession();
    const { url, session } = await signInFlow(client, tb.fetch);
    const u = new URL(url);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("https://agent.example/oauth/callback");
    expect(session).toMatchObject({ signedIn: true, sessionId: before.sessionId, scope: ALL_SCOPES });
    expect(await client.accountToken()).toMatchObject({ scope: ALL_SCOPES });
    const at = (await client.accountToken())!.token;
    expect((await tb.company.stores.accountTokens.get(at))).toMatchObject({ clientId: tb.agent.clientId, accountId: "acct_tipper" });
    expect((await tb.company.stores.sessions.get(before.sessionId))).toMatchObject({ accountId: "acct_tipper" });
    // The signed-in token is bound to this request's DPoP key.
    expect((await tb.company.stores.tokens.get(session.token))!.jkt)
      .toBe(await jwkThumbprint((await dpopKeyFor(vault, COMPANY)).publicJwk));
  });

  test("warns when the granted scope is narrower than requested (F9)", async () => {
    const { tb } = await setup();
    const lines: string[] = [];
    const { createLogger } = await import("poppy-core");
    const client = tb.client(new MemoryVault(), { log: createLogger("agent", (l) => lines.push(l)) });
    const { session } = await signInFlow(client, tb.fetch, { untick: ["poppy:write"] });
    expect(session.scope).toEqual(["poppy:read", "standings"]);
    expect(lines.some((l) => l.includes("signin.scope_narrowed missing=poppy:write"))).toBe(true);
    expect(lines.join("\n")).not.toContain((await client.accountToken())!.token);
  });

  test("access_denied is reported, and nothing is stored", async () => {
    const { tb, client, tokenPosts } = await setup();
    const url = await client.beginSignIn(ALL_SCOPES);
    const before = tokenPosts();
    const cb = await userSignsIn(new TestBrowser(tb.fetch), url, { decision: "deny" });
    await rejectsWith(client.completeSignIn(cb), "access_denied");
    expect(tokenPosts()).toBe(before);
    expect(await client.accountToken()).toBeUndefined();
  });
});

describe("the agent aborts before any token request", () => {
  async function withCallback(mutate: (u: URL) => void, code: string) {
    const { tb, client, tokenPosts } = await setup();
    const url = await client.beginSignIn(ALL_SCOPES);
    const cb = new URL(await userSignsIn(new TestBrowser(tb.fetch), url));
    mutate(cb);
    const before = tokenPosts();
    await rejectsWith(client.completeSignIn(cb.toString()), code);
    expect(tokenPosts()).toBe(before);
    expect(client.session!.signedIn).toBe(false);
  }

  test("A-05: a mismatched iss (mix-up)", () => withCallback((u) => u.searchParams.set("iss", "https://evil.example"),
    "iss_mismatch"));
  test("A-05: a missing iss", () => withCallback((u) => u.searchParams.delete("iss"), "iss_mismatch"));
  test("A-15: the wrong state", () => withCallback((u) => u.searchParams.set("state", "forged"), "state_mismatch"));
  test("no code", () => withCallback((u) => u.searchParams.delete("code"), "invalid_callback"));

  test("a callback with no sign-in in progress, or a second use of the same callback", async () => {
    const { tb, client } = await setup();
    await rejectsWith(client.completeSignIn("https://agent.example/oauth/callback?code=x&state=y"), "no_signin_pending");
    const { callback } = await signInFlow(client, tb.fetch);
    await rejectsWith(client.completeSignIn(callback), "no_signin_pending");
  });
});

describe("state carries the loopback port", () => {
  test("beginSignIn with a loopback port", async () => {
    const { client } = await setup();
    const state = new URL(await client.beginSignIn(["poppy:read"], { loopbackPort: 49152 })).searchParams.get("state")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{22}\.49152$/);
  });
});
