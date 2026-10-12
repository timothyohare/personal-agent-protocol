// The conversation API (spec section 7, Task 15) with the scripted echo agent.
import { describe, expect, test } from "vitest";
import { AgentConversation, MemoryVault, newMessageId } from "agent";
import { clampWait, type CompanyAgent } from "../src/index.ts";
import { COMPANY, testbed } from "../../../test-support/testbed.ts";
import { signInFlow } from "../../../test-support/signin.ts";

const P = "/conversations";

async function setup(o: { companyAgent?: CompanyAgent } = {}) {
  const tb = await testbed(o);
  const client = tb.client(new MemoryVault());
  const post = (path: string, body: unknown) => client.call("POST", path, body);
  const msg = (text: string, id = newMessageId()) => ({ message: { id, sender: "agent", text } });
  return { tb, client, post, msg, settle: () => tb.company.conversations.settle() };
}

const types = (events: { type: string }[]) => events.map((e) => e.type);

describe("discovery", () => {
  test("poppy.json lists the conversation endpoint under agent.protocols (F15)", async () => {
    const tb = await testbed();
    const doc = await (await tb.fetch(`${COMPANY}/.well-known/poppy.json`)).json() as Record<string, unknown>;
    expect(doc.agent).toEqual({ protocols: [{ type: "poppy", endpoint: `${COMPANY}/conversations` }] });
  });
});

describe("starting and messaging (7.3)", () => {
  test("POST starts a conversation: 201 with conversation_id, status and responder", async () => {
    const { post, msg } = await setup();
    const r = await post(P, msg("Hello"));
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ conversation_id: expect.stringMatching(/^cnv_[A-Za-z0-9_-]{16}$/), status: "idle", responder: "agent" });
  });

  test("events follow briefing 9.8: the user message, working, the reply, idle", async () => {
    const { post, msg, client, settle } = await setup();
    const id = (await post(P, msg("Hello"))).body as { conversation_id: string };
    await settle();
    const r = await client.call("GET", `${P}/${id.conversation_id}/events`);
    const body = r.body as { events: Record<string, unknown>[] } & Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["conversation_id", "cursor", "events", "has_more", "responder", "status"]);
    expect(types(body.events as { type: string }[])).toEqual(["message", "state", "message", "state"]);
    const [user, working, reply, idle] = body.events as Record<string, unknown>[];
    expect(user).toMatchObject({ type: "message", message: { role: "user", sender: "agent", text: "Hello" } });
    expect(user!.id).toMatch(/^evt_/);
    expect(new Date(user!.created_at as string).toISOString()).toBe(user!.created_at);
    expect(working).toMatchObject({ type: "state", status: "working", responder: "agent" });
    expect(reply).toMatchObject({ type: "message", message: { role: "company", sender: "agent", text: "You said: Hello" } });
    expect((reply as { message: { id: string } }).message.id).toMatch(/^msg_/);
    expect(idle).toMatchObject({ type: "state", status: "idle", responder: "agent" });
    expect(body).toMatchObject({ cursor: idle!.id, has_more: false, status: "idle", responder: "agent" });
  });

  test("later messages are 202; data-only messages are answered too", async () => {
    const { post, msg, settle, client } = await setup();
    const { conversation_id: id } = (await post(P, msg("Hi"))).body as { conversation_id: string };
    expect((await post(`${P}/${id}/messages`, msg("Again"))).status).toBe(202);
    expect((await post(`${P}/${id}/messages`, { message: { id: newMessageId(), sender: "agent", data: { order: 1042 } } })).status)
      .toBe(202);
    await settle();
    const ev = (await client.call("GET", `${P}/${id}/events`)).body as { events: { type: string; message?: { text?: string; data?: unknown } }[] };
    const company = ev.events.filter((e) => e.type === "message" && (e.message as { role: string }).role === "company");
    expect(company.map((e) => e.message!.text)).toEqual(["You said: Hi", "You said: Again", "Thanks, I've got those details."]);
  });

  test("a context-only update is accepted, adds no message and gets no reply", async () => {
    const { post, msg, settle, client, tb } = await setup();
    const { conversation_id: id } = (await post(P, msg("Hi"))).body as { conversation_id: string };
    await settle();
    const before = ((await client.call("GET", `${P}/${id}/events`)).body as { events: unknown[] }).events.length;
    expect((await post(`${P}/${id}/messages`, { message: { id: newMessageId(), sender: "agent",
      context: { locale: "en-AU", time_zone: "Australia/Sydney" } } })).status).toBe(202);
    await post(`${P}/${id}/messages`, { message: { id: newMessageId(), sender: "agent", context: { user_available: false } } });
    await settle();
    expect(((await client.call("GET", `${P}/${id}/events`)).body as { events: unknown[] }).events.length).toBe(before);
    // Fields left out keep their values (7.4).
    expect((await tb.company.conversations.stores.conversations.get(id))!.context)
      .toEqual({ locale: "en-AU", time_zone: "Australia/Sydney", user_available: false });
  });

  test("invalid messages are 400 invalid_request", async () => {
    const { post } = await setup();
    for (const message of [undefined, { sender: "agent", text: "x" }, { id: "has space", sender: "agent", text: "x" },
      { id: "m".repeat(257), sender: "agent", text: "x" }, { id: "msg_1", sender: "bot", text: "x" }, { id: "msg_1", sender: "agent" },
      { id: "msg_1", sender: "agent", text: 5 }, { id: "msg_1", sender: "agent", data: [1] },
      { id: "msg_1", sender: "agent", context: { locale: "not a tag!" } },
      { id: "msg_1", sender: "agent", context: { time_zone: "Mars/Olympus" } },
      { id: "msg_1", sender: "agent", context: { user_available: "yes" } }]) {
      expect(await post(P, { message })).toMatchObject({ status: 400, error: "invalid_request" });
    }
  });
});

describe("retries and conflicts (7.3, F18, A-31)", () => {
  test("a retried first message returns the same conversation and adds nothing", async () => {
    const { post, msg, settle, client } = await setup();
    const m = msg("Hello");
    const a = (await post(P, m)).body as { conversation_id: string };
    const b = await post(P, m);
    expect(b.status).toBe(201);
    expect((b.body as { conversation_id: string }).conversation_id).toBe(a.conversation_id);
    await settle();
    const ev = (await client.call("GET", `${P}/${a.conversation_id}/events`)).body as { events: { type: string }[] };
    expect(ev.events.filter((e) => e.type === "message")).toHaveLength(2);
  });

  test("a retried later message is 202 with no duplicate; reusing an id with other content is 409", async () => {
    const { post, msg, settle, client } = await setup();
    const { conversation_id: id } = (await post(P, msg("Hi"))).body as { conversation_id: string };
    const m = msg("Second");
    await post(`${P}/${id}/messages`, m);
    expect((await post(`${P}/${id}/messages`, m)).status).toBe(202);
    await settle();
    const ev = (await client.call("GET", `${P}/${id}/events`)).body as { events: { type: string }[] };
    expect(ev.events.filter((e) => e.type === "message")).toHaveLength(4);
    expect(await post(`${P}/${id}/messages`, { message: { ...m.message, text: "Different" } }))
      .toMatchObject({ status: 409, error: "message_id_conflict" });
    // A first-message id reused as a later message, or the other way round, is also a conflict.
    const first = msg("Start");
    const { conversation_id: id2 } = (await post(P, first)).body as { conversation_id: string };
    expect((await post(`${P}/${id2}/messages`, first)).error).toBe("message_id_conflict");
    expect((await post(P, m)).error).toBe("message_id_conflict");
  });

  test("message ids are per User: another User may use the same id", async () => {
    const { post, msg, tb } = await setup();
    const m = msg("Hi", "msg_shared");
    await post(P, m);
    const other = tb.client(new MemoryVault());
    expect((await other.call("POST", P, m)).status).toBe(201);
  });
});

describe("ownership (7.2, F17, A-25)", () => {
  test("another User, another agent, or an unknown id all get the same 404", async () => {
    const { post, msg, tb } = await setup();
    const { conversation_id: id } = (await post(P, msg("Hi"))).body as { conversation_id: string };
    const otherUser = tb.client(new MemoryVault());
    const otherAgent = tb.client(new MemoryVault(), {}, (await tb.addAgent("other.example")).identity);
    for (const c of [otherUser, otherAgent]) {
      for (const [m, p, b] of [["GET", `${P}/${id}/events`, undefined], ["POST", `${P}/${id}/messages`, msg("x")],
        ["POST", `${P}/${id}/close`, {}]] as const) {
        expect(await c.call(m, p, b)).toMatchObject({ status: 404, error: "conversation_not_found" });
      }
    }
    expect((await tb.client().call("GET", `${P}/cnv_nope/events`)).error).toBe("conversation_not_found");
  });

  test("any Session of the same agent and User can continue it", async () => {
    const { post, msg, tb, client } = await setup();
    const { conversation_id: id } = (await post(P, msg("Hi"))).body as { conversation_id: string };
    await client.startSession(); // a new Session, same vault (same User ID)
    expect((await post(`${P}/${id}/messages`, msg("Still me"))).status).toBe(202);
    void tb;
  });

  test("7.11: once it has used the account, a signed-out token gets sign_in_required and another account 404", async () => {
    const useAccount: CompanyAgent = async (t) => {
      if (!t.caller.signedIn) return t.needAuthorization("sign_in_required", "poppy:read");
      await t.useAccount(t.caller.accountId!);
      await t.say("Done with your account.");
    };
    const { tb, client, settle } = await setup({ companyAgent: useAccount });
    await signInFlow(client, tb.fetch);
    const c = await AgentConversation.start(client, "Show my tips");
    await settle();
    expect((await tb.company.conversations.stores.conversations.get(c.id))!.accountId).toBe("acct_tipper");
    await client.startSession({ renew: true }); // a signed-out token for the same Session...
    await client.signOut(); // ...and no Account Token to sign it back in
    expect(await client.call("GET", `${P}/${c.id}/events`)).toMatchObject({ status: 403, error: "sign_in_required" });
  });
});

describe("events: cursors, paging and long-poll (7.5, F20)", () => {
  test("A-30: a malformed cursor or another conversation's cursor is 400 invalid_cursor", async () => {
    const { post, msg, client, settle } = await setup();
    const a = ((await post(P, msg("A"))).body as { conversation_id: string }).conversation_id;
    const b = ((await post(P, msg("B"))).body as { conversation_id: string }).conversation_id;
    await settle();
    const cursorB = ((await client.call("GET", `${P}/${b}/events`)).body as { cursor: string }).cursor;
    expect(await client.call("GET", `${P}/${a}/events?cursor=${cursorB}`)).toMatchObject({ status: 400, error: "invalid_cursor" });
    expect((await client.call("GET", `${P}/${a}/events?cursor=garbage`)).error).toBe("invalid_cursor");
  });

  test("reading from a cursor returns only newer events; an empty read keeps the cursor", async () => {
    const { post, msg, client, settle } = await setup();
    const id = ((await post(P, msg("A"))).body as { conversation_id: string }).conversation_id;
    await settle();
    const first = (await client.call("GET", `${P}/${id}/events`)).body as { cursor: string };
    const empty = (await client.call("GET", `${P}/${id}/events?cursor=${first.cursor}`)).body as { events: unknown[]; cursor: string };
    expect(empty).toMatchObject({ events: [], cursor: first.cursor, has_more: false });
  });

  test("has_more pages through long histories (50 a page), and the agent client reads them all", async () => {
    const quiet: CompanyAgent = async () => {};
    const { client, settle } = await setup({ companyAgent: quiet });
    const c = await AgentConversation.start(client, "m0");
    for (let i = 1; i < 60; i++) await c.send(`m${i}`);
    await settle();
    const page = (await client.call("GET", `${P}/${c.id}/events`)).body as { events: unknown[]; has_more: boolean };
    expect(page).toMatchObject({ has_more: true });
    expect(page.events).toHaveLength(50);
    const all = await c.events();
    expect(all.filter((e) => e.type === "message")).toHaveLength(60);
    expect(await c.events()).toEqual([]);
  });

  test("long-poll: a read with wait returns as soon as the reply arrives", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: CompanyAgent = async (t) => { await gate; await t.say("Late reply"); };
    const { client } = await setup({ companyAgent: slow });
    const c = await AgentConversation.start(client, "Hi");
    await c.events();
    setTimeout(release, 50);
    const t0 = Date.now();
    const got = await c.events(10);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(got.some((e) => e.type === "message" && e.message.text === "Late reply")).toBe(true);
  });

  test("a long-poll with nothing new returns an empty list when the wait ends", async () => {
    const quiet: CompanyAgent = async () => {};
    const { client, settle } = await setup({ companyAgent: quiet });
    const c = await AgentConversation.start(client, "Hi");
    await settle();
    await c.events();
    const t0 = Date.now();
    expect(await c.events(1)).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  test("A-29: wait is capped at 25 s", () => {
    expect(clampWait(600)).toBe(25);
    expect(clampWait(-5)).toBe(0);
    expect(clampWait(3)).toBe(3);
  });

  test("POST ?wait returns the reply in the same response, keeping 201/202", async () => {
    const { post, msg } = await setup();
    const r = await post(`${P}?wait=5`, msg("Hi"));
    expect(r.status).toBe(201);
    const body = r.body as { events: { type: string; message?: { text: string } }[]; conversation_id: string };
    expect(body.conversation_id).toMatch(/^cnv_/);
    expect(body.events[0]).toMatchObject({ type: "message" });
    const later = await post(`${P}/${body.conversation_id}/messages?wait=5&cursor=${(body as unknown as { cursor: string }).cursor}`, msg("More"));
    expect(later.status).toBe(202);
    expect((later.body as { events: unknown[] }).events.length).toBeGreaterThan(0);
  });
});

describe("closing (7.12)", () => {
  test("close adds a closed state event; later messages are 409 conversation_closed; events stay readable", async () => {
    const { post, msg, client, settle } = await setup();
    const id = ((await post(P, msg("Hi"))).body as { conversation_id: string }).conversation_id;
    await settle();
    const r = await post(`${P}/${id}/close`, {});
    expect(r).toMatchObject({ status: 200, body: { conversation_id: id, status: "closed", responder: "agent" } });
    expect(await post(`${P}/${id}/messages`, msg("Hello?"))).toMatchObject({ status: 409, error: "conversation_closed" });
    const ev = (await client.call("GET", `${P}/${id}/events`)).body as { events: { type: string; status?: string }[]; status: string };
    expect(ev.events.at(-1)).toMatchObject({ type: "state", status: "closed" });
    expect(ev.status).toBe("closed");
    // Closing twice is harmless and adds nothing.
    await post(`${P}/${id}/close`, {});
    expect(((await client.call("GET", `${P}/${id}/events`)).body as { events: unknown[] }).events).toHaveLength(ev.events.length);
  });

  test("A-32: the worker does nothing for a message to a conversation closed before it ran", async () => {
    let calls = 0;
    const counting: CompanyAgent = async (t) => { calls++; await t.say("hi"); };
    const held: (() => Promise<void>)[] = [];
    const tb = await testbed({ companyAgent: counting, scheduleAgent: (job) => { held.push(job); } });
    const client = tb.client(new MemoryVault());
    const c = await AgentConversation.start(client, "Hi");
    await c.close(); // closes before the queued agent job runs
    for (const job of held) await job();
    expect(held).toHaveLength(1);
    expect(calls).toBe(0);
  });
});

describe("agent client", () => {
  test("start, send, nextReply and close; sender defaults to agent (7.8)", async () => {
    const { client } = await setup();
    const c = await AgentConversation.start(client, { text: "Hello", context: { locale: "en-AU" } });
    const r = await c.nextReply(5);
    expect(r.find((e) => e.type === "message" && e.message.role === "company")).toMatchObject({ message: { text: "You said: Hello" } });
    expect(r.find((e) => e.type === "message" && e.message.role === "user")).toMatchObject({ message: { sender: "agent" } });
    await c.send({ text: "my own words", sender: "human" });
    expect((await c.nextReply(5)).some((e) => e.type === "message" && e.message.sender === "human")).toBe(true);
    await c.close();
    expect(c.status).toBe("closed");
  });

  test("unknown event types are skipped", async () => {
    const { client, tb } = await setup();
    const c = await AgentConversation.start(client, "Hi");
    await tb.company.conversations.settle();
    await tb.company.conversations.stores.events.append(c.id, { type: "x-future-event" } as never);
    const got = await c.events();
    expect(got.some((e) => (e.type as string) === "x-future-event")).toBe(false);
    expect(got.length).toBeGreaterThan(0);
  });

  test("a company without a conversation protocol is reported", async () => {
    const { client, tb } = await setup();
    const real = tb.hosts["tipping.example"]!;
    tb.hosts["tipping.example"] = { fetch: async (r) => {
      const res = await real.fetch(r);
      if (!r.url.endsWith("/poppy.json")) return res;
      const { agent: _a, ...rest } = await res.json() as Record<string, unknown>;
      return Response.json(rest);
    } };
    await expect(AgentConversation.start(client, "Hi")).rejects.toMatchObject({ code: "no_conversation_api" });
  });
});
