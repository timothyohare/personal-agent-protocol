import { expect, test } from "vitest";
import { createCompany, tippingCo } from "../src/index.ts";

const { app } = createCompany(tippingCo("https://tipping.ohare.id.au", false));

test("poppy.json matches briefing 9.3", async () => {
  const res = await app.request("/.well-known/poppy.json");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  expect(await res.json()).toEqual({
    protocol_version: "0.1",
    organization: { name: "Tipping Co", domain: "tipping.ohare.id.au" },
    auth: {
      issuer: "https://tipping.ohare.id.au",
      direct: { scopes: ["poppy:read", "poppy:write", "standings"] },
      custom_scopes: { standings: "See your position on the competition ladder" },
    },
    apis: [{ type: "openapi", url: "https://tipping.ohare.id.au/openapi.json",
      description: "Fixtures, ladder, your tips and score" }],
    agent: { protocols: [{ type: "poppy", endpoint: "https://tipping.ohare.id.au/conversations" }] },
  });
});

test("OAuth metadata matches briefing 9.3 and publishes the ES256 DPoP pin (S5 F3)", async () => {
  const res = await app.request("/.well-known/oauth-authorization-server");
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  expect(await res.json()).toMatchObject({
    issuer: "https://tipping.ohare.id.au",
    authorization_endpoint: "https://tipping.ohare.id.au/oauth/authorize",
    token_endpoint: "https://tipping.ohare.id.au/oauth/token",
    revocation_endpoint: "https://tipping.ohare.id.au/oauth/revoke",
    poppy_domains: ["tipping.ohare.id.au"],
    dpop_signing_alg_values_supported: ["ES256"],
    code_challenge_methods_supported: ["S256"],
  });
});

test("a local base URL keeps its port in the domain, and a trailing slash is dropped from the issuer", async () => {
  const { app: local } = createCompany(tippingCo("http://localhost:8787/", true));
  const body = await (await local.request("/.well-known/poppy.json")).json() as
    { organization: { domain: string }; auth: { issuer: string } };
  expect(body.organization.domain).toBe("localhost:8787");
  expect(body.auth.issuer).toBe("http://localhost:8787");
});
