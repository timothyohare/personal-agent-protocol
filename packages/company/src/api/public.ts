import { Hono } from "hono";
import { CURRENT_ROUND, FIXTURES, LADDER } from "../data.ts";
import type { AuthEnv } from "../middleware.ts";

/** Signed-out APIs: any valid Session Token works (briefing 9.2). */
export function publicApi(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/api/fixtures", (ctx) => {
    const q = ctx.req.query("round");
    const round = q === undefined ? CURRENT_ROUND : Number(q);
    if (!Number.isInteger(round)) return ctx.json({ error: "invalid_request", error_description: "round" }, 400);
    return ctx.json({ round, current_round: CURRENT_ROUND, fixtures: FIXTURES.filter((f) => f.round === round) });
  });
  app.get("/api/ladder", (ctx) => ctx.json({ ladder: LADDER }));
  return app;
}
