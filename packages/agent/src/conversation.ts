// The Personal Agent's side of a conversation (spec section 7).
import { PoppyError, rid, type AgentMessage, type ConversationEvent, type EventsResponse, type Responder, type Status } from "poppy-core";
import type { CompanyClient } from "./company.ts";

const KNOWN = new Set(["message", "state", "authorization", "user_requested", "direct_opened", "direct_closed"]);

export const newMessageId = (): string => `msg_${rid(12)}`;

/** The company's conversation endpoint from poppy.json `agent.protocols` (type `poppy`), as a path. */
export async function conversationEndpoint(company: CompanyClient): Promise<string> {
  const { poppy } = await company.discovered();
  const protocols = (poppy as { agent?: { protocols?: { type: string; endpoint: string }[] } }).agent?.protocols ?? [];
  const p = protocols.find((x) => x.type === "poppy");
  if (!p) throw new PoppyError("no_conversation_api", 0, "this company lists no poppy conversation protocol");
  const u = new URL(p.endpoint);
  if (u.origin !== await company.apiOrigin()) throw new PoppyError("no_conversation_api", 0, "endpoint on another origin");
  return u.pathname;
}

export type Outgoing = string | Omit<AgentMessage, "id" | "sender"> & { sender?: AgentMessage["sender"] };

function toMessage(m: Outgoing): AgentMessage {
  // A summary or paraphrase of the user's words is still the agent's (7.8): default to "agent".
  return typeof m === "string" ? { id: newMessageId(), sender: "agent", text: m }
    : { id: newMessageId(), sender: m.sender ?? "agent", ...m };
}

export class AgentConversation {
  readonly company: CompanyClient;
  readonly path: string;
  readonly id: string;
  status: Status;
  responder: Responder;
  /** The last event handled; reads continue from here (7.5). */
  cursor: string | undefined;
  private readonly seen = new Set<string>();

  private constructor(company: CompanyClient, path: string, id: string, status: Status, responder: Responder) {
    this.company = company;
    this.path = path;
    this.id = id;
    this.status = status;
    this.responder = responder;
  }

  private static check(r: { status: number; body: unknown; error?: string }, ok: number): Record<string, unknown> {
    if (r.status !== ok) {
      const body = (r.body ?? {}) as { error_description?: string };
      throw new PoppyError(r.error ?? `http_${r.status}`, r.status, body.error_description);
    }
    return r.body as Record<string, unknown>;
  }

  /** Starts a conversation with its first message (7.3). Optionally as a Direct Conversation (7.10). */
  static async start(company: CompanyClient, first: Outgoing, o: { parentId?: string } = {}): Promise<AgentConversation> {
    const path = await conversationEndpoint(company);
    const message = toMessage(first);
    const body = AgentConversation.check(await company.call("POST", path,
      { message, ...(o.parentId ? { parent_conversation_id: o.parentId } : {}) }), 201);
    company.log.event("conversation.started", { conversation_id: body.conversation_id });
    return new AgentConversation(company, path, String(body.conversation_id), body.status as Status, body.responder as Responder);
  }

  /** Sends a message. Retrying with the same message is safe (7.3). */
  async send(m: Outgoing | AgentMessage): Promise<void> {
    const message = typeof m === "object" && "id" in m && typeof m.id === "string" ? m as AgentMessage : toMessage(m as Outgoing);
    const body = AgentConversation.check(await this.company.call("POST", `${this.path}/${this.id}/messages`, { message }), 202);
    this.status = body.status as Status;
    this.responder = body.responder as Responder;
  }

  /**
   * Reads new events, long-polling up to `wait` seconds. Skips unknown types and events already
   * handled, keeps reading while has_more, and advances the cursor (7.5).
   */
  async events(wait = 0): Promise<ConversationEvent[]> {
    const out: ConversationEvent[] = [];
    let first = true;
    for (;;) {
      const q = new URLSearchParams();
      if (this.cursor) q.set("cursor", this.cursor);
      if (first && wait > 0) q.set("wait", String(wait));
      const r = AgentConversation.check(await this.company.call("GET",
        `${this.path}/${this.id}/events${q.size ? `?${q}` : ""}`), 200) as unknown as EventsResponse;
      for (const e of r.events) {
        if (this.seen.has(e.id)) continue;
        this.seen.add(e.id);
        if (KNOWN.has(e.type)) out.push(e);
      }
      if (r.cursor) this.cursor = r.cursor;
      this.status = r.status;
      this.responder = r.responder;
      first = false;
      if (!r.has_more) return out;
    }
  }

  /** Reads until a company message arrives, or `timeoutS` passes. */
  async nextReply(timeoutS = 25): Promise<ConversationEvent[]> {
    const until = Date.now() + timeoutS * 1000;
    const got: ConversationEvent[] = [];
    while (Date.now() < until) {
      got.push(...await this.events(Math.min(25, Math.ceil((until - Date.now()) / 1000))));
      if (got.some((e) => e.type === "message" && e.message.role === "company")
        || got.some((e) => e.type === "authorization" || e.type === "user_requested")) break;
    }
    return got;
  }

  async close(): Promise<void> {
    const body = AgentConversation.check(await this.company.call("POST", `${this.path}/${this.id}/close`, {}), 200);
    this.status = body.status as Status;
  }
}
