import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { testbed } from "../../../test-support/testbed.ts";

async function run(argv: string[]) {
  const tb = await testbed();
  const lines: string[] = [];
  const code = await runCli(argv, tb.client(), (s) => lines.push(s));
  return { code, out: lines.join("\n") };
}

test("fixtures prints the current round", async () => {
  const { code, out } = await run(["fixtures"]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ round: 27 });
});

test("fixtures with a round, ladder, discover and session", async () => {
  expect(JSON.parse((await run(["fixtures", "28"])).out).round).toBe(28);
  expect(JSON.parse((await run(["ladder"])).out).ladder).toHaveLength(17);
  expect(JSON.parse((await run(["discover"])).out)).toMatchObject({ name: "Tipping Co", issuer: "https://tipping.example" });
  expect(JSON.parse((await run(["session"])).out)).toMatchObject({ signed_in: false, scope: [] });
});

test("call prints errors and exits 1; unknown commands print usage and exit 2", async () => {
  const r = await run(["call", "get", "/api/nope"]);
  expect(r.code).toBe(1);
  const u = await run(["bogus"]);
  expect(u.code).toBe(2);
  expect(u.out).toMatch(/^usage/);
  expect((await run(["call", "GET"])).code).toBe(2);
});

test("signin: the user opens the URL, and the agent-host page forwards the result to the loopback listener", async () => {
  const tb = await testbed();
  const { TestBrowser, userSignsIn, parseForm } = await import("../../../test-support/browser.ts");
  const lines: string[] = [];
  const client = tb.client();
  const code = await runCli(["signin", "poppy:read"], client, {
    out: (s) => lines.push(s),
    showSignInUrl: (url) => {
      void (async () => {
        const cbUrl = await userSignsIn(new TestBrowser(tb.fetch), url);
        // The browser loads the agent host's callback page, which posts to 127.0.0.1:<port>.
        const page = await (await tb.fetch(cbUrl)).text();
        const f = parseForm(page);
        await fetch(f.action!, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(f.hidden) });
      })();
    },
  });
  expect(code).toBe(0);
  expect(JSON.parse(lines.join("\n"))).toMatchObject({ signed_in: true, scope: ["poppy:read"] });
  const status: string[] = [];
  await runCli(["status"], client, (s) => status.push(s));
  expect(JSON.parse(status.join("\n"))).toMatchObject({ account_token: { stored: true } });
});

test("signin: a pasted callback URL works when the loopback hop is blocked", async () => {
  const tb = await testbed();
  const { TestBrowser, userSignsIn } = await import("../../../test-support/browser.ts");
  let url = "";
  const code = await runCli(["signin"], tb.client(), {
    out: () => {},
    showSignInUrl: (u) => { url = u; },
    pastedCallback: async () => { await new Promise((r) => setTimeout(r, 5)); return userSignsIn(new TestBrowser(tb.fetch), url); },
  });
  expect(code).toBe(0);
});

/** A CLI io that plays the user whenever a sign-in URL is shown. */
async function userIo(tb: Awaited<ReturnType<typeof testbed>>, lines: string[], untick: string[] = []) {
  const { TestBrowser, userSignsIn } = await import("../../../test-support/browser.ts");
  let url = "";
  return {
    out: (s: string) => lines.push(s),
    showSignInUrl: (u: string) => { url = u; },
    pastedCallback: async () => { await new Promise((r) => setTimeout(r, 1)); return userSignsIn(new TestBrowser(tb.fetch), url, { untick }); },
  };
}

test("tip: signs in when needed, then tips the Storm this round", async () => {
  const tb = await testbed();
  const lines: string[] = [];
  const client = tb.client();
  expect(await runCli(["tip", "storm"], client, await userIo(tb, lines))).toBe(0);
  expect(lines[0]).toMatch(/sign in/);
  expect(JSON.parse(lines.slice(1).join("\n"))).toMatchObject({ fixture_id: "r27-1", team: "Storm" });
  const t: string[] = [];
  await runCli(["tips"], client, await userIo(tb, t));
  expect(JSON.parse(t.join("\n")).tips).toHaveLength(1);
});

test("tip: a team not playing, and a missing scope", async () => {
  const tb = await testbed();
  const lines: string[] = [];
  expect(await runCli(["tip", "Nobody"], tb.client(), await userIo(tb, lines))).toBe(1);
  expect(lines.join(" ")).toMatch(/isn't playing/);
  const l2: string[] = [];
  const c = tb.client();
  expect(await runCli(["tip", "Warriors", "27"], c, await userIo(tb, l2, ["poppy:write"]))).toBe(1);
  expect(l2.join(" ")).toMatch(/haven't allowed the "poppy:write" scope/);
  expect(await runCli(["score"], c, await userIo(tb, []))).toBe(0);
});
