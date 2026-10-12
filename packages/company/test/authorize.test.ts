import { describe, expect, test } from "vitest";
import { pkceChallenge, pkceVerifier } from "poppy-core";
import { COMPANY, testbed } from "../../../test-support/testbed.ts";
import { TestBrowser, parseForm, userSignsIn } from "../../../test-support/browser.ts";

const CB = "https://agent.example/oauth/callback";

async function setup(opts: Parameters<typeof testbed>[0] = {}) {
  const tb = await testbed(opts);
  const verifier = pkceVerifier();
  const authUrl = (over: Record<string, string | undefined> = {}) => {
    const u = new URL(`${COMPANY}/oauth/authorize`);
    const params: Record<string, string | undefined> = {
      response_type: "code", client_id: tb.agent.clientId, redirect_uri: CB, scope: "poppy:read poppy:write standings",
      state: "st_123", code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", ...over,
    };
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  };
  return { tb, verifier, authUrl, browser: new TestBrowser(tb.fetch) };
}

const params = (loc: string) => Object.fromEntries(new URL(loc).searchParams);

describe("happy path", () => {
  test("login, consent, then a redirect with code, state and iss", async () => {
    const { tb, authUrl, browser } = await setup();
    const loc = await userSignsIn(browser, authUrl());
    expect(loc.startsWith(`${CB}?`)).toBe(true);
    const p = params(loc);
    expect(p).toMatchObject({ state: "st_123", iss: COMPANY });
    const code = (await tb.company.stores.codes.get(p.code!))!;
    expect(code).toMatchObject({ clientId: tb.agent.clientId, redirectUri: CB, accountId: "acct_tipper",
      scope: ["poppy:read", "poppy:write", "standings"] });
    expect(code.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
  });

  test("unticking a scope leaves it out of the code (A-23)", async () => {
    const { tb, authUrl, browser } = await setup();
    const p = params(await userSignsIn(browser, authUrl(), { untick: ["poppy:write"] }));
    expect((await tb.company.stores.codes.get(p.code!))!.scope).toEqual(["poppy:read", "standings"]);
  });

  test("declining redirects with access_denied, state and iss (S4 G4)", async () => {
    const { authUrl, browser } = await setup();
    const p = params(await userSignsIn(browser, authUrl(), { decision: "deny" }));
    expect(p).toEqual({ error: "access_denied", state: "st_123", iss: COMPANY });
  });

  test("unticking every scope counts as declining", async () => {
    const { authUrl, browser } = await setup();
    const p = params(await userSignsIn(browser, authUrl({ scope: "poppy:read" }), { untick: ["poppy:read"] }));
    expect(p.error).toBe("access_denied");
  });

  test("the consent page shows the client_name and the client_id host (T-11)", async () => {
    const { authUrl, browser } = await setup();
    const start = await browser.get(authUrl());
    const f = parseForm(await start.text());
    const res = await browser.post(`${COMPANY}/oauth/authorize/login`, [["req", f.hidden.req!], ["csrf", f.hidden.csrf!],
      ["username", "tipper"], ["password", "correct horse battery staple"]]);
    const html = await res.text();
    expect(html).toContain("Test Agent");
    expect(html).toContain('<span class="host">agent.example</span>');
    expect(html).toContain("See your position on the competition ladder");
  });

  test("pages forbid framing and caching, and expose no WebMCP tools (T-10, A-41)", async () => {
    const { authUrl, browser } = await setup();
    const res = await browser.get(authUrl());
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("permissions-policy")).toBe("tools=()");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("names chosen by the agent are escaped", async () => {
    const { tb, authUrl, browser } = await setup();
    const evil = await tb.addAgent("evil.example", "<script>alert(1)</script>");
    const html = await (await browser.get(authUrl({ client_id: evil.clientId,
      redirect_uri: "https://evil.example/oauth/callback" }))).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("refused without redirecting (error page)", () => {
  const expectErrorPage = async (res: Response, status = 400) => {
    expect(res.status).toBe(status);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("can't continue");
  };

  test("A-16: redirect_uri not registered, including prefix and suffix variants", async () => {
    const { authUrl, browser } = await setup();
    for (const r of ["https://evil.example/cb", `${CB}/extra`, `${CB}?x=1`, "https://agent.example/oauth/callbac",
      "http://agent.example/oauth/callback", undefined]) {
      await expectErrorPage(await browser.get(authUrl({ redirect_uri: r })));
    }
  });

  test("A-14: PKCE missing, plain, or a malformed challenge", async () => {
    const { authUrl, browser } = await setup();
    await expectErrorPage(await browser.get(authUrl({ code_challenge_method: "plain" })));
    await expectErrorPage(await browser.get(authUrl({ code_challenge_method: undefined })));
    await expectErrorPage(await browser.get(authUrl({ code_challenge: undefined })));
    await expectErrorPage(await browser.get(authUrl({ code_challenge: "short" })));
  });

  test("an unverifiable client_id, or none", async () => {
    const { authUrl, browser } = await setup();
    await expectErrorPage(await browser.get(authUrl({ client_id: "https://nobody.example/agent.json" })));
    await expectErrorPage(await browser.get(authUrl({ client_id: undefined })));
  });
});

describe("error redirects to the validated redirect_uri (with iss)", () => {
  test("A-44: missing, unknown or unavailable scope gives invalid_scope", async () => {
    const { authUrl, browser } = await setup();
    for (const scope of [undefined, "", "admin", "poppy:read admin", "favourites"]) {
      const res = await browser.get(authUrl({ scope }));
      expect(res.status).toBe(303);
      expect(params(res.headers.get("location")!)).toEqual({ error: "invalid_scope", state: "st_123", iss: COMPANY });
    }
  });

  test("a wrong response_type, and a missing state", async () => {
    const { authUrl, browser } = await setup();
    expect(params((await browser.get(authUrl({ response_type: "token" }))).headers.get("location")!).error)
      .toBe("unsupported_response_type");
    expect(params((await browser.get(authUrl({ state: undefined }))).headers.get("location")!))
      .toEqual({ error: "invalid_request", iss: COMPANY });
  });
});

describe("CSRF and login (T-9, A-17)", () => {
  async function atLogin() {
    const s = await setup();
    const f = parseForm(await (await s.browser.get(s.authUrl())).text());
    return { ...s, req: f.hidden.req!, csrf: f.hidden.csrf! };
  }
  const login = (b: TestBrowser, req: string, csrf: string, password = "correct horse battery staple") =>
    b.post(`${COMPANY}/oauth/authorize/login`, [["req", req], ["csrf", csrf], ["username", "tipper"], ["password", password]]);

  test("login without, or with the wrong, CSRF token is 403", async () => {
    const { browser, req } = await atLogin();
    expect((await login(browser, req, "")).status).toBe(403);
    expect((await login(browser, req, "wrong")).status).toBe(403);
  });

  test("a form posted from another browser (no cookie) is 403", async () => {
    const { tb, req, csrf } = await atLogin();
    expect((await login(new TestBrowser(tb.fetch), req, csrf)).status).toBe(403);
  });

  test("A-17: consent without, or with the wrong, CSRF token is 403 and issues no code", async () => {
    const { browser, req, csrf, tb } = await atLogin();
    expect((await login(browser, req, csrf)).status).toBe(200);
    for (const bad of ["", "wrong"]) {
      const res = await browser.post(`${COMPANY}/oauth/authorize/consent`, [["req", req], ["csrf", bad],
        ["scope", "poppy:read"], ["decision", "approve"]]);
      expect(res.status).toBe(403);
    }
    // The refused posts didn't use up the request: the right token still works, once.
    const ok = await browser.post(`${COMPANY}/oauth/authorize/consent`, [["req", req], ["csrf", csrf],
      ["scope", "poppy:read"], ["decision", "approve"]]);
    expect(ok.status).toBe(303);
    const code = new URL(ok.headers.get("location")!).searchParams.get("code")!;
    expect(await tb.company.stores.codes.get(code)).toMatchObject({ scope: ["poppy:read"] });
  });

  test("consent before login is refused", async () => {
    const { browser, req, csrf } = await atLogin();
    const res = await browser.post(`${COMPANY}/oauth/authorize/consent`, [["req", req], ["csrf", csrf],
      ["scope", "poppy:read"], ["decision", "approve"]]);
    expect(res.status).toBe(400);
  });

  test("a wrong password re-shows the login form (401); a later right one works", async () => {
    const { browser, req, csrf } = await atLogin();
    const bad = await login(browser, req, csrf, "nope");
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain("Wrong username or password");
    expect((await login(browser, req, csrf)).status).toBe(200);
  });

  test("password attempts are rate limited per sign-in request", async () => {
    const tb0 = await setup({ loginRateLimit: 2 });
    const f = parseForm(await (await tb0.browser.get(tb0.authUrl())).text());
    await login(tb0.browser, f.hidden.req!, f.hidden.csrf!, "x");
    await login(tb0.browser, f.hidden.req!, f.hidden.csrf!, "x");
    const third = await login(tb0.browser, f.hidden.req!, f.hidden.csrf!);
    expect(await third.text()).toContain("Too many attempts");
  });

  test("a consent can't be replayed: the request is gone after use", async () => {
    const { browser, req, csrf } = await atLogin();
    await login(browser, req, csrf);
    const consent = () => browser.post(`${COMPANY}/oauth/authorize/consent`, [["req", req], ["csrf", csrf],
      ["scope", "poppy:read"], ["decision", "approve"]]);
    expect((await consent()).status).toBe(303);
    expect((await consent()).status).toBe(400);
  });

  test("granted scopes can't exceed the request, even if the form adds one", async () => {
    const { browser, req, csrf, tb } = await atLogin();
    await login(browser, req, csrf);
    const res = await browser.post(`${COMPANY}/oauth/authorize/consent`, [["req", req], ["csrf", csrf],
      ["scope", "poppy:read"], ["scope", "admin"], ["decision", "approve"]]);
    const code = params(res.headers.get("location")!).code!;
    expect((await tb.company.stores.codes.get(code))!.scope).toEqual(["poppy:read"]);
  });
});
