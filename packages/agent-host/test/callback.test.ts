import { expect, test } from "vitest";
import { createAgentHost, loopbackPort } from "../src/index.ts";

const app = createAgentHost({ baseUrl: "https://agent.example", clientName: "A",
  publicJwks: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "k" }] });

test("loopbackPort accepts only <nonce>.<port> with a non-privileged port", () => {
  expect(loopbackPort(`${"a".repeat(22)}.49152`)).toBe(49152);
  expect(loopbackPort(`${"a".repeat(22)}.1024`)).toBe(1024);
  expect(loopbackPort(`${"a".repeat(22)}.65535`)).toBe(65535);
  expect(loopbackPort(`${"a".repeat(22)}.1023`)).toBeUndefined();
  expect(loopbackPort(`${"a".repeat(22)}.65536`)).toBeUndefined();
  expect(loopbackPort(`${"a".repeat(21)}.49152`)).toBeUndefined();
  expect(loopbackPort("evil.example.com")).toBeUndefined();
  expect(loopbackPort(`${"a".repeat(22)}.49152/evil`)).toBeUndefined();
  expect(loopbackPort(undefined)).toBeUndefined();
});

test("the callback page posts code, state and iss to the loopback port, escaped, and never to anywhere else", async () => {
  const state = `${"s".repeat(22)}.49152`;
  const res = await app.request(`/oauth/callback?code=c"><x&state=${state}&iss=https%3A%2F%2Ftipping.example&evil=1`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('action="http://127.0.0.1:49152/cb"');
  expect(html).toContain('name="code" value="c&quot;&gt;&lt;x"');
  expect(html).toContain(`name="state" value="${state}"`);
  expect(html).not.toContain('name="evil"');
  expect(res.headers.get("content-security-policy")).toContain("form-action http://127.0.0.1:*");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("a callback without a loopback state is refused with no form", async () => {
  const res = await app.request("/oauth/callback?code=c&state=evil.example.com");
  expect(res.status).toBe(400);
  expect(await res.text()).not.toContain("<form");
});
