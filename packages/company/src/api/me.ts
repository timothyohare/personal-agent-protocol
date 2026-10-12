// Signed-in APIs (briefing 9.2): tips need poppy:read / poppy:write, the score needs the custom standings scope.
import { Hono } from "hono";
import { FIXTURES } from "../data.ts";
import { requireScope, type AuthEnv } from "../middleware.ts";
import type { Stores, Tip } from "../stores.ts";

const tipsOf = (stores: Stores, accountId: string) => {
  let m = stores.tips.get(accountId);
  if (!m) stores.tips.set(accountId, m = new Map());
  return m;
};

export function meApi(stores: Stores): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/api/me/tips", requireScope("poppy:read"), (ctx) => {
    const tips = [...tipsOf(stores, ctx.get("auth").accountId!).values()].sort((a, b) => a.fixture_id.localeCompare(b.fixture_id));
    return ctx.json({ tips });
  });

  app.post("/api/me/tips", requireScope("poppy:write"), async (ctx) => {
    const body = await ctx.req.json().catch(() => null) as { fixture_id?: unknown; team?: unknown } | null;
    const bad = (d: string) => ctx.json({ error: "invalid_tip", error_description: d }, 400);
    if (!body || typeof body.fixture_id !== "string" || typeof body.team !== "string") {
      return bad("send {\"fixture_id\": string, \"team\": string}");
    }
    const fixture = FIXTURES.find((f) => f.id === body.fixture_id);
    if (!fixture) return bad(`unknown fixture ${body.fixture_id}`);
    const team = [fixture.home, fixture.away].find((t) => t.toLowerCase() === (body.team as string).toLowerCase());
    if (!team) return bad(`${body.team} isn't playing in ${fixture.id} (${fixture.home} v ${fixture.away})`);
    const auth = ctx.get("auth");
    const tip: Tip = { fixture_id: fixture.id, round: fixture.round, team, submitted_at: new Date().toISOString() };
    tipsOf(stores, auth.accountId!).set(fixture.id, tip);
    return ctx.json(tip, 201);
  });

  app.get("/api/me/score", requireScope("standings"), (ctx) => {
    const tipped = tipsOf(stores, ctx.get("auth").accountId!).size;
    // No results are recorded for the demo rounds, so the score is a fixed season baseline plus new tips.
    return ctx.json({ season: 2026, correct: 142, tipped: 208 + tipped, position: 37, entrants: 1250 });
  });

  return app;
}
