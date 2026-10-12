import { expect, test } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import { createAgentHost } from "../src/index.ts";

const pub = async () => ({ ...(await exportJWK((await generateKeyPair("ES256")).publicKey)), kid: "k1", alg: "ES256" });

test("agent.json matches briefing 9.4", async () => {
  const app = createAgentHost({ baseUrl: "https://agent.ohare.id.au", clientName: "Tim's Agent", publicJwks: [await pub()] });
  const res = await app.request("/agent.json");
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  expect(await res.json()).toEqual({
    client_id: "https://agent.ohare.id.au/agent.json",
    client_name: "Tim's Agent",
    jwks_uri: "https://agent.ohare.id.au/jwks.json",
    redirect_uris: ["https://agent.ohare.id.au/oauth/callback"],
    token_endpoint_auth_method: "private_key_jwt",
  });
});

test("jwks.json publishes the public key with its kid", async () => {
  const k = await pub();
  const app = createAgentHost({ baseUrl: "https://agent.ohare.id.au", clientName: "A", publicJwks: [k] });
  const res = await app.request("/jwks.json");
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  expect(await res.json()).toEqual({ keys: [k] });
});

test("refuses to publish a private key or a key without a kid", async () => {
  const kp = await generateKeyPair("ES256", { extractable: true });
  const priv = { ...(await exportJWK(kp.privateKey)), kid: "k1" };
  expect(() => createAgentHost({ baseUrl: "https://a.example", clientName: "A", publicJwks: [priv] })).toThrow(/public/);
  const { kid: _kid, ...noKid } = await pub();
  expect(() => createAgentHost({ baseUrl: "https://a.example", clientName: "A", publicJwks: [noKid] })).toThrow(/kid/);
});
