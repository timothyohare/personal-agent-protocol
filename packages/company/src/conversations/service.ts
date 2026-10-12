// The conversation API's behaviour (spec section 7), independent of HTTP.
import { EventEmitter } from "node:events";
import {
  PoppyError, messageFingerprint, type AgentMessage, type ConversationEvent, type EventsResponse, type Responder,
  type Status,
} from "poppy-core";
import type { Logger } from "poppy-core";
import { newConversationId, type Conversation, type ConversationStores } from "./store.ts";

/** Who is calling, from their Session Token (7.2). */
export interface Caller {
  clientId: string;
  userId: string;
  signedIn: boolean;
  accountId: string | null;
  scope: string[];
}

/** What a company agent can do while handling a message. */
export interface AgentTurn {
  conversation: Conversation;
  message: AgentMessage;
  caller: Caller;
  /** Adds a company message (role: company). */
  say(text: string, o?: { data?: Record<string, unknown>; sender?: "agent" | "human" }): Promise<void>;
  /** Asks for sign-in or a scope (7.11). */
  needAuthorization(error: "sign_in_required" | "insufficient_scope", scope?: string): Promise<void>;
  /** Records that the conversation has used the caller's account; it then belongs to that account. */
  useAccount(accountId: string): Promise<void>;
}

/** The company's side of the conversation: scripted in Task 15, Claude-backed in Task 16. */
export type CompanyAgent = (turn: AgentTurn) => Promise<void>;

export const echoAgent: CompanyAgent = async (t) => {
  if (t.message.text !== undefined) await t.say(`You said: ${t.message.text}`);
  else if (t.message.data !== undefined) await t.say("Thanks, I've got those details.", { data: { received: t.message.data } });
};

export const MAX_WAIT_S = 25;

/** A requested long-poll wait, in seconds, clamped to [0, 25] (A-29). */
export const clampWait = (s: number): number => Math.min(Math.max(s, 0), MAX_WAIT_S);
const PAGE = 50;
/** How often a long-poll re-reads the log, for writes made by other instances. */
const POLL_MS = 500;

const notFound = () => new PoppyError("conversation_not_found", 404);

export interface ServiceOptions {
  agent?: CompanyAgent;
  log: Logger;
  /** Runs the company agent after a message is accepted. Local: in-process; Lambda: a worker (Task 16). */
  schedule?: (job: () => Promise<void>) => void;
}

export class ConversationService {
  readonly stores: ConversationStores;
  readonly agent: CompanyAgent;
  private readonly log: Logger;
  private readonly schedule: (job: () => Promise<void>) => void;
  private readonly changes = new EventEmitter().setMaxListeners(0);
  /** Pending agent jobs, so tests and shutdown can wait for them. */
  private readonly running = new Set<Promise<void>>();

  constructor(stores: ConversationStores, o: ServiceOptions) {
    this.stores = stores;
    this.agent = o.agent ?? echoAgent;
    this.log = o.log;
    this.schedule = o.schedule ?? ((job) => {
      const p = job().catch((e) => this.log.event("conversation.agent_failed", { error: (e as Error).message }))
        .finally(() => this.running.delete(p));
      this.running.add(p);
    });
  }

  /** Waits until every scheduled agent job has finished (tests). */
  async settle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  // ---------- access ----------

  /**
   * Loads a conversation the caller may use (7.2). Every ownership failure looks the same (404).
   * Once the conversation has used an account, a token not signed in to it gets sign_in_required (7.11).
   */
  async owned(id: string, caller: Caller): Promise<Conversation> {
    const c = await this.stores.conversations.get(id);
    if (!c || c.clientId !== caller.clientId || c.userId !== caller.userId) throw notFound();
    if (c.accountId !== null) {
      if (!caller.signedIn) throw new PoppyError("sign_in_required", 403, "this conversation uses your account");
      if (caller.accountId !== c.accountId) throw notFound();
    }
    return c;
  }

  private messageKey = (caller: Caller, id: string) => `${caller.clientId} ${caller.userId} ${id}`;

  // ---------- writes ----------

  private async append(c: Conversation, e: Parameters<ConversationStores["events"]["append"]>[1]) {
    const event = await this.stores.events.append(c.id, e);
    this.changes.emit(c.id);
    return event;
  }

  /** Sets status and responder, adding a state event if either changed (7.7). */
  async setState(c: Conversation, status: Status, responder: Responder = c.responder): Promise<void> {
    if (c.status === status && c.responder === responder) return;
    c.status = status;
    c.responder = responder;
    await this.stores.conversations.put(c.id, c);
    await this.append(c, { type: "state", status, responder });
  }

  private async addUserMessage(c: Conversation, m: AgentMessage) {
    if (m.context) {
      c.context = { ...c.context, ...m.context };
      await this.stores.conversations.put(c.id, c);
    }
    if (m.text !== undefined || m.data !== undefined) {
      await this.append(c, { type: "message", message: { id: m.id, role: "user", sender: m.sender,
        ...(m.text !== undefined ? { text: m.text } : {}), ...(m.data !== undefined ? { data: m.data } : {}) } });
    }
  }

  /** Hands a message to the company agent, unless a person is handling (or about to handle) the conversation. */
  private dispatch(c: Conversation, m: AgentMessage, caller: Caller) {
    if (c.responder === "human" || c.status === "queued") return;
    if (m.text === undefined && m.data === undefined) return; // a context-only update needs no reply
    this.schedule(async () => {
      const conv = await this.stores.conversations.get(c.id);
      if (!conv || conv.status === "closed") return; // re-read: it may have closed meanwhile (A-32)
      await this.setState(conv, "working");
      await this.agent(this.turn(conv, m, caller));
      const after = (await this.stores.conversations.get(c.id))!;
      if (after.status === "working") await this.setState(after, "idle");
    });
  }

  private turn(c: Conversation, message: AgentMessage, caller: Caller): AgentTurn {
    return {
      conversation: c, message, caller,
      say: async (text, o = {}) => {
        await this.append(c, { type: "message", message: { id: `msg_${newConversationId().slice(4)}`, role: "company",
          sender: o.sender ?? "agent", text, ...(o.data ? { data: o.data } : {}) } });
      },
      needAuthorization: async (error, scope) => {
        await this.append(c, { type: "authorization", error, ...(scope ? { scope } : {}) });
      },
      useAccount: async (accountId) => {
        const fresh = (await this.stores.conversations.get(c.id))!;
        fresh.accountId = accountId;
        c.accountId = accountId;
        await this.stores.conversations.put(c.id, fresh);
      },
    };
  }

  /** POST {endpoint}: starts a conversation with its first message (7.3). Retries return the same one. */
  async start(caller: Caller, m: AgentMessage): Promise<{ conversation: Conversation; status: 201 }> {
    const key = this.messageKey(caller, m.id);
    const fingerprint = messageFingerprint(m);
    const c: Conversation = {
      id: newConversationId(), clientId: caller.clientId, userId: caller.userId, accountId: null, status: "idle",
      responder: "agent", context: {}, parentId: null, directChildId: null, handoffDeadline: null, createdAt: Date.now(),
    };
    if (!await this.stores.messages.create(key, { conversationId: c.id, fingerprint, status: 201 })) {
      return { conversation: await this.retry(caller, key, fingerprint, 201), status: 201 };
    }
    await this.stores.conversations.put(c.id, c);
    this.log.event("conversation.started", { conversation_id: c.id, client_id: caller.clientId });
    await this.addUserMessage(c, m);
    this.dispatch(c, m, caller);
    return { conversation: c, status: 201 };
  }

  /** A message id seen before: the same content is a retry, different content a conflict (7.3). */
  private async retry(caller: Caller, key: string, fingerprint: string, expected: 201 | 202, conversationId?: string) {
    const prev = (await this.stores.messages.get(key))!;
    if (prev.fingerprint !== fingerprint || prev.status !== expected
      || (conversationId !== undefined && prev.conversationId !== conversationId)) {
      throw new PoppyError("message_id_conflict", 409, "this message id was already used with different content");
    }
    return this.owned(prev.conversationId, caller);
  }

  /** POST {endpoint} with parent_conversation_id: a Direct Conversation (7.10). Task 19. */
  async startDirect(_caller: Caller, _parentId: string, _m: AgentMessage): Promise<{ conversation: Conversation; status: 201 }> {
    throw new PoppyError("invalid_request", 400, "direct conversations are not supported yet");
  }

  /** POST {id}/messages (7.3). */
  async send(id: string, caller: Caller, m: AgentMessage): Promise<Conversation> {
    const c = await this.owned(id, caller);
    const key = this.messageKey(caller, m.id);
    const fingerprint = messageFingerprint(m);
    if (!await this.stores.messages.create(key, { conversationId: c.id, fingerprint, status: 202 })) {
      return this.retry(caller, key, fingerprint, 202, c.id);
    }
    if (c.status === "closed") {
      await this.stores.messages.delete(key);
      throw new PoppyError("conversation_closed", 409);
    }
    if (c.directChildId) {
      await this.stores.messages.delete(key);
      throw Object.assign(new PoppyError("direct_conversation_open", 409), { extra: { conversation_id: c.directChildId } });
    }
    await this.addUserMessage(c, m);
    this.dispatch(c, m, caller);
    return c;
  }

  /** POST {id}/close (7.12). */
  async close(id: string, caller: Caller): Promise<Conversation> {
    const c = await this.owned(id, caller);
    if (c.status !== "closed") {
      c.handoffDeadline = null;
      await this.setState(c, "closed");
      this.log.event("conversation.closed", { conversation_id: c.id });
    }
    return c;
  }

  // ---------- reads ----------

  /**
   * GET {id}/events (7.5): events after `cursor` (an event id), long-polling up to `wait` seconds
   * (capped at 25, A-29) when there's nothing new.
   */
  async read(id: string, caller: Caller, cursor: string | undefined, waitS: number): Promise<EventsResponse> {
    await this.owned(id, caller);
    const deadline = Date.now() + clampWait(waitS) * 1000;
    for (;;) {
      const all = await this.stores.events.list(id);
      let start = 0;
      if (cursor !== undefined) {
        const i = all.findIndex((e) => e.id === cursor);
        if (i < 0) throw new PoppyError("invalid_cursor", 400, "unknown cursor, or one from another conversation");
        start = i + 1;
      }
      const events = all.slice(start, start + PAGE);
      if (events.length > 0 || Date.now() >= deadline) {
        const c = (await this.stores.conversations.get(id))!;
        return {
          conversation_id: id, events, cursor: events.at(-1)?.id ?? cursor ?? null,
          has_more: start + events.length < all.length, status: c.status, responder: c.responder,
        };
      }
      await this.changed(id, Math.min(POLL_MS, deadline - Date.now()));
    }
  }

  private changed(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.changes.off(id, done); resolve(); };
      const t = setTimeout(done, ms);
      this.changes.on(id, done);
    });
  }

  /** The events a new SSE subscriber or poller hasn't seen. */
  async eventsAfter(id: string, cursor: string | undefined): Promise<ConversationEvent[]> {
    const all = await this.stores.events.list(id);
    if (cursor === undefined) return all;
    const i = all.findIndex((e) => e.id === cursor);
    if (i < 0) throw new PoppyError("invalid_cursor", 400, "unknown cursor, or one from another conversation");
    return all.slice(i + 1);
  }
}
