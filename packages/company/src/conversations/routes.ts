// HTTP routes for the conversation API (spec 7.2): POST /conversations, /{id}/messages, /{id}/close,
// GET /{id}/events. Every request carries a DPoP Session Token (the API middleware checks it).
import { Hono, type Context } from "hono";
import { PoppyError, messageProblem, type AgentMessage, type EventsResponse } from "poppy-core";
import type { AuthEnv } from "../middleware.ts";
import type { Caller, ConversationService } from "./service.ts";

export const CONVERSATIONS_PATH = "/conversations";

const callerOf = (ctx: Context<AuthEnv>): Caller => {
  const a = ctx.get("auth");
  return { clientId: a.session.clientId, userId: a.session.userId, signedIn: a.signedIn, accountId: a.accountId, scope: a.scope };
};

function errorBody(ctx: Context, e: PoppyError) {
  const extra = (e as PoppyError & { extra?: Record<string, string> }).extra ?? {};
  return ctx.json({ error: e.code, ...(e.detail ? { error_description: e.detail } : {}), ...extra }, e.status as 400,
    { "cache-control": "no-store" });
}

async function readMessage(ctx: Context): Promise<{ message: AgentMessage; parent?: string }> {
  const body = await ctx.req.json().catch(() => null) as { message?: unknown; parent_conversation_id?: unknown } | null;
  const problem = body ? messageProblem(body.message) : "body must be JSON";
  if (problem) throw new PoppyError("invalid_request", 400, problem);
  if (body!.parent_conversation_id !== undefined && typeof body!.parent_conversation_id !== "string") {
    throw new PoppyError("invalid_request", 400, "parent_conversation_id must be a string");
  }
  return { message: body!.message as AgentMessage,
    ...(typeof body!.parent_conversation_id === "string" ? { parent: body!.parent_conversation_id } : {}) };
}

const waitParam = (ctx: Context): number | undefined => {
  const w = ctx.req.query("wait");
  if (w === undefined) return undefined;
  const n = Number(w);
  if (!Number.isFinite(n) || n < 0) throw new PoppyError("invalid_request", 400, "wait must be a number of seconds");
  return n;
};

export function conversationRoutes(svc: ConversationService): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const P = CONVERSATIONS_PATH;

  /** A POST's response: status fields, or (with ?wait) a read from the cursor (7.3). */
  const postResponse = async (ctx: Context<AuthEnv>, id: string, status: 201 | 202) => {
    const wait = waitParam(ctx);
    const c = (await svc.stores.conversations.get(id))!;
    if (wait === undefined) return ctx.json({ conversation_id: id, status: c.status, responder: c.responder }, status);
    const r: EventsResponse = await svc.read(id, callerOf(ctx), ctx.req.query("cursor"), wait);
    return ctx.json(r, status);
  };

  const handle = (fn: (ctx: Context<AuthEnv>) => Promise<Response>) => async (ctx: Context<AuthEnv>) => {
    try {
      return await fn(ctx);
    } catch (e) {
      if (e instanceof PoppyError) return errorBody(ctx, e);
      throw e;
    }
  };

  app.post(P, handle(async (ctx) => {
    const { message, parent } = await readMessage(ctx);
    const { conversation } = parent !== undefined
      ? await svc.startDirect(callerOf(ctx), parent, message)
      : await svc.start(callerOf(ctx), message);
    return postResponse(ctx, conversation.id, 201);
  }));

  app.post(`${P}/:id/messages`, handle(async (ctx) => {
    const { message } = await readMessage(ctx);
    const c = await svc.send(ctx.req.param("id")!, callerOf(ctx), message);
    return postResponse(ctx, c.id, 202);
  }));

  app.post(`${P}/:id/close`, handle(async (ctx) => {
    const c = await svc.close(ctx.req.param("id")!, callerOf(ctx));
    return ctx.json({ conversation_id: c.id, status: c.status, responder: c.responder }, 200);
  }));

  app.get(`${P}/:id/events`, handle(async (ctx) => {
    const r = await svc.read(ctx.req.param("id")!, callerOf(ctx), ctx.req.query("cursor"), waitParam(ctx) ?? 0);
    return ctx.json(r, 200, { "cache-control": "no-store" });
  }));

  return app;
}
