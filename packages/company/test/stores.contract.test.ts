// The store contract (Task 13). Runs against the in-memory stores always, and against DynamoDB
// Local when DYNAMODB_ENDPOINT is set (npm run test:dynamo, and gate-verify).
import { describe, expect, test } from "vitest";
import { rid } from "poppy-core";
import { memoryStores, type Session, type Stores } from "../src/index.ts";
import { dynamoStores, ensureTable } from "../src/stores/dynamo.ts";

const backends: [string, () => Promise<Stores>][] = [["memory", async () => memoryStores()]];
if (process.env.DYNAMODB_ENDPOINT) {
  const o = { table: process.env.DYNAMODB_TABLE ?? "poppy-test", endpoint: process.env.DYNAMODB_ENDPOINT };
  backends.push(["dynamodb", async () => { await ensureTable(o); return dynamoStores({ ...o, namespace: rid() }); }]);
}

const session = (over: Partial<Session> = {}): Session => ({ id: `ses_${rid()}`, clientId: "https://a.example/agent.json",
  userId: "u_1", accountId: null, accountTokenId: null, ended: false, createdAt: 1, ...over });

describe.each(backends)("%s stores", (_name, make) => {
  test("get, put, delete; unknown ids are undefined", async () => {
    const s = await make();
    expect(await s.sessions.get("nope")).toBeUndefined();
    const x = session();
    await s.sessions.put(x.id, x);
    expect(await s.sessions.get(x.id)).toEqual(x);
    await s.sessions.delete(x.id);
    expect(await s.sessions.get(x.id)).toBeUndefined();
  });

  test("records are copies: changing one without put changes nothing", async () => {
    const s = await make();
    const x = session();
    await s.sessions.put(x.id, x);
    x.ended = true;
    const got = (await s.sessions.get(x.id))!;
    expect(got.ended).toBe(false);
    got.ended = true;
    expect((await s.sessions.get(x.id))!.ended).toBe(false);
  });

  test("an expired item is invisible to get and take", async () => {
    const s = await make();
    await s.pending.put("p1", { id: "p1" } as never, Date.now() - 1);
    expect(await s.pending.get("p1")).toBeUndefined();
    expect(await s.pending.take("p1")).toBeUndefined();
    await s.pending.put("p2", { id: "p2" } as never, Date.now() + 60_000);
    expect(await s.pending.get("p2")).toEqual({ id: "p2" });
  });

  test("A-40: take hands an item to exactly one of 20 concurrent callers", async () => {
    const s = await make();
    await s.codes.put("c1", { code: "c1" } as never, Date.now() + 60_000);
    const got = await Promise.all(Array.from({ length: 20 }, () => s.codes.take("c1")));
    expect(got.filter(Boolean)).toHaveLength(1);
    expect(await s.codes.get("c1")).toBeUndefined();
  });

  test("A-40: the replay store accepts a key exactly once across 20 concurrent callers, then again after expiry", async () => {
    const s = await make();
    const ok = await Promise.all(Array.from({ length: 20 }, () => s.replay.checkAndAdd("jti-1", 60_000)));
    expect(ok.filter(Boolean)).toHaveLength(1);
    expect(await s.replay.checkAndAdd("jti-2", 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(await s.replay.checkAndAdd("jti-2", 60_000)).toBe(true);
  });

  test("signOutByAccountToken signs out only that Account Token's Sessions", async () => {
    const s = await make();
    const a = session({ accountId: "acct_1", accountTokenId: "at_a" });
    const b = session({ accountId: "acct_1", accountTokenId: "at_a" });
    const c = session({ accountId: "acct_1", accountTokenId: "at_c" });
    for (const x of [a, b, c]) await s.sessions.put(x.id, x);
    expect(await s.sessions.signOutByAccountToken("at_a")).toBe(2);
    expect(await s.sessions.get(a.id)).toMatchObject({ accountId: null, accountTokenId: null, userId: "u_1" });
    expect(await s.sessions.get(c.id)).toMatchObject({ accountId: "acct_1", accountTokenId: "at_c" });
    expect(await s.sessions.signOutByAccountToken("at_a")).toBe(0);
    // A Session signed in again later, with a new Account Token, isn't touched by the old one.
    await s.sessions.put(a.id, { ...a, accountTokenId: "at_new" });
    expect(await s.sessions.signOutByAccountToken("at_a")).toBe(0);
  });

  test("tips: listed per account, sorted, and replaced per fixture", async () => {
    const s = await make();
    const tip = (fixture_id: string, team: string) => ({ fixture_id, team, round: 27, submitted_at: "t" });
    await s.tips.put("acct_1", tip("r27-2", "Sharks"));
    await s.tips.put("acct_1", tip("r27-1", "Storm"));
    await s.tips.put("acct_1", tip("r27-1", "Broncos"));
    await s.tips.put("acct_2", tip("r27-3", "Roosters"));
    expect((await s.tips.list("acct_1")).map((t) => [t.fixture_id, t.team])).toEqual([["r27-1", "Broncos"], ["r27-2", "Sharks"]]);
    expect(await s.tips.list("acct_9")).toEqual([]);
  });

  test("the test users are seeded", async () => {
    const s = await make();
    await new Promise((r) => setTimeout(r, 0));
    expect(await s.users.get("tipper")).toMatchObject({ accountId: "acct_tipper" });
    expect(await s.users.get("rival")).toMatchObject({ accountId: "acct_rival" });
  });
});
