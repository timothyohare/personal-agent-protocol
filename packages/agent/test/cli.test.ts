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
