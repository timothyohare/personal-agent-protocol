// Conversation state (Task 15): the conversation record, the per-User message-ID index used for
// retries and conflicts (7.3), and an append-only event log per conversation.
import { rid, type ConversationEvent, type MessageContext, type Responder, type Status } from "poppy-core";
import { MemoryTable, type Table } from "../stores.ts";

export interface Conversation {
  id: string;
  /** Owner (7.2): the agent and User that started it, and the account once it has used one. */
  clientId: string;
  userId: string;
  accountId: string | null;
  status: Status;
  responder: Responder;
  context: MessageContext;
  /** For a Direct Conversation, its parent (7.10). */
  parentId: string | null;
  /** The parent's open Direct Conversation, if any. */
  directChildId: string | null;
  /** When a pending handoff gives up waiting for a person (7.9). */
  handoffDeadline: number | null;
  createdAt: number;
}

export interface MessageRecord {
  conversationId: string;
  fingerprint: string;
  /** 201 if this message started the conversation, else 202. */
  status: 201 | 202;
}

export interface EventLog {
  /** Appends an event, giving it a new id. Events keep the order they were appended in. */
  append(conversationId: string, event: DistributiveOmit<ConversationEvent, "id" | "created_at">): Promise<ConversationEvent>;
  list(conversationId: string): Promise<ConversationEvent[]>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface ConversationStores {
  conversations: Table<Conversation>;
  /** Keyed by `${client_id} ${user_id} ${message id}`. */
  messages: Table<MessageRecord>;
  events: EventLog;
}

export const newEventId = (): string => `evt_${rid(12)}`;
export const newConversationId = (): string => `cnv_${rid(12)}`;

export class MemoryEventLog implements EventLog {
  private logs = new Map<string, ConversationEvent[]>();

  async append(conversationId: string, e: DistributiveOmit<ConversationEvent, "id" | "created_at">) {
    const event = { ...e, id: newEventId(), created_at: new Date().toISOString() } as ConversationEvent;
    let log = this.logs.get(conversationId);
    if (!log) this.logs.set(conversationId, log = []);
    log.push(structuredClone(event));
    return event;
  }

  async list(conversationId: string) {
    return structuredClone(this.logs.get(conversationId) ?? []);
  }
}

export function memoryConversationStores(): ConversationStores {
  return { conversations: new MemoryTable(), messages: new MemoryTable(), events: new MemoryEventLog() };
}
