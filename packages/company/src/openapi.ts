import type { ResolvedConfig } from "./config.ts";

const err = { $ref: "#/components/schemas/Error" };
const json = (schema: object) => ({ content: { "application/json": { schema } } });
const errors = {
  401: { description: "invalid_token, invalid_dpop_proof or use_dpop_nonce", ...json(err) },
  403: { description: "sign_in_required or insufficient_scope", ...json(err) },
};

/** The OpenAPI document listed in poppy.json. */
export function openApi(c: ResolvedConfig) {
  const fixture = {
    type: "object", required: ["id", "round", "home", "away", "venue", "kickoff"],
    properties: { id: { type: "string" }, round: { type: "integer" }, home: { type: "string" },
      away: { type: "string" }, venue: { type: "string" }, kickoff: { type: "string", format: "date-time" } },
  };
  const tip = {
    type: "object", required: ["fixture_id", "team"],
    properties: { fixture_id: { type: "string" }, team: { type: "string" }, round: { type: "integer" },
      submitted_at: { type: "string", format: "date-time" } },
  };
  return {
    openapi: "3.1.0",
    info: { title: `${c.name} API`, version: "1.0.0", description: c.apiDescription },
    servers: [{ url: c.baseUrl }],
    security: [{ dpop: [] }],
    components: {
      securitySchemes: {
        dpop: { type: "http", scheme: "DPoP", description: "A Poppy Session Token with a DPoP proof (RFC 9449)" },
      },
      schemas: {
        Error: { type: "object", required: ["error"],
          properties: { error: { type: "string" }, error_description: { type: "string" }, scope: { type: "string" } } },
        Fixture: fixture,
        Tip: tip,
      },
    },
    paths: {
      "/api/fixtures": { get: {
        summary: "Fixtures for a round (signed out is fine)",
        parameters: [{ name: "round", in: "query", required: false, schema: { type: "integer" } }],
        responses: { 200: { description: "Fixtures", ...json({ type: "object", required: ["round", "current_round", "fixtures"],
          properties: { round: { type: "integer" }, current_round: { type: "integer" },
            fixtures: { type: "array", items: { $ref: "#/components/schemas/Fixture" } } } }) },
        400: { description: "Bad round", ...json(err) }, 401: errors[401] },
      } },
      "/api/ladder": { get: {
        summary: "Competition ladder (signed out is fine)",
        responses: { 200: { description: "Ladder", ...json({ type: "object", required: ["ladder"], properties: {
          ladder: { type: "array", items: { type: "object", required: ["team", "played", "won", "lost", "points"], properties: {
            team: { type: "string" }, played: { type: "integer" }, won: { type: "integer" }, lost: { type: "integer" },
            points: { type: "integer" } } } } } }) }, 401: errors[401] },
      } },
      "/api/me/tips": {
        get: { summary: "Your tips (scope poppy:read)", "x-poppy-scope": "poppy:read",
          responses: { 200: { description: "Tips", ...json({ type: "object", required: ["tips"], properties: {
            tips: { type: "array", items: { $ref: "#/components/schemas/Tip" } } } }) }, ...errors } },
        post: { summary: "Submit or change a tip (scope poppy:write)", "x-poppy-scope": "poppy:write",
          requestBody: { required: true, ...json({ type: "object", required: ["fixture_id", "team"], properties: {
            fixture_id: { type: "string" }, team: { type: "string" } } }) },
          responses: { 201: { description: "Saved", ...json({ $ref: "#/components/schemas/Tip" }) },
            400: { description: "Invalid tip", ...json(err) }, ...errors } },
      },
      "/api/me/score": { get: { summary: "Your score and ladder position (custom scope standings)",
        "x-poppy-scope": "standings",
        responses: { 200: { description: "Score", ...json({ type: "object", required: ["correct", "tipped", "position"],
          properties: { correct: { type: "integer" }, tipped: { type: "integer" }, position: { type: "integer" } } }) },
        ...errors } } },
    },
  };
}
