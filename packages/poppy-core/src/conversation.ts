// Conversation protocol shapes (spec section 7, docs/spec-section7-notes.md), shared by company and agent.

export const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

export type Status = "working" | "idle" | "queued" | "closed";
export type Responder = "agent" | "human";
export type Sender = "agent" | "human";

export interface MessageContext {
  locale?: string;
  time_zone?: string;
  user_available?: boolean;
  [k: string]: unknown;
}

/** A message from the Personal Agent (7.4). */
export interface AgentMessage {
  id: string;
  sender: Sender;
  text?: string;
  data?: Record<string, unknown>;
  context?: MessageContext;
}

/** A message as it appears in events: `role` says which side it came from (7.5). */
export interface EventMessage {
  id: string;
  role: "user" | "company";
  sender: Sender;
  text?: string;
  data?: Record<string, unknown>;
}

export type ConversationEvent =
  | { id: string; type: "message"; created_at: string; message: EventMessage }
  | { id: string; type: "state"; created_at: string; status: Status; responder: Responder }
  | { id: string; type: "authorization"; created_at: string; error: "sign_in_required" | "insufficient_scope"; scope?: string }
  | { id: string; type: "user_requested"; created_at: string; reason: string }
  | { id: string; type: "direct_opened" | "direct_closed"; created_at: string; conversation_id: string };

export interface EventsResponse {
  conversation_id: string;
  events: ConversationEvent[];
  cursor: string | null;
  has_more: boolean;
  status: Status;
  responder: Responder;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks a Personal Agent message (7.4). Returns an error description, or undefined if valid. */
export function messageProblem(m: unknown): string | undefined {
  if (!isObject(m)) return "message must be an object";
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) return "message.id must be 1-256 URL-safe base64 characters";
  if (m.sender !== "agent" && m.sender !== "human") return "message.sender must be agent or human";
  if (m.text === undefined && m.data === undefined && m.context === undefined) {
    return "message needs at least one of text, data or context";
  }
  if (m.text !== undefined && typeof m.text !== "string") return "message.text must be a string";
  if (m.data !== undefined && !isObject(m.data)) return "message.data must be an object";
  if (m.context !== undefined) {
    if (!isObject(m.context)) return "message.context must be an object";
    const c = m.context;
    if (c.locale !== undefined && (typeof c.locale !== "string" || !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(c.locale))) {
      return "context.locale must be a BCP 47 tag";
    }
    if (c.time_zone !== undefined && (typeof c.time_zone !== "string" || !validTimeZone(c.time_zone))) {
      return "context.time_zone must be an IANA time zone";
    }
    if (c.user_available !== undefined && typeof c.user_available !== "boolean") return "context.user_available must be a boolean";
  }
  return undefined;
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A stable fingerprint of a message's content, for retry detection (7.3). */
export function messageFingerprint(m: AgentMessage): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return JSON.stringify(sort({ sender: m.sender, text: m.text, data: m.data, context: m.context }));
}
