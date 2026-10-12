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
