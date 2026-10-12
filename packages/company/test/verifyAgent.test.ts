import { afterEach, describe, expect, test, vi } from "vitest";
import { PoppyError, createLogger } from "poppy-core";
import { createAgentVerifier, isBlockedAddress, resolveConfig, tippingCo, type CompanyConfig } from "../src/index.ts";

const ID = "https://agent.example/agent.json";
const META = { client_id: ID, client_name: "A", jwks_uri: "https://agent.example/jwks.json",
  redirect_uris: ["https://agent.example/oauth/callback"], token_endpoint_auth_method: "private_key_jwt" };
const JWKS = { keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "k" }] };

type Doc = unknown | ((init: RequestInit | undefined) => Response);

function verifier(docs: Record<string, Doc>, over: Partial<CompanyConfig> = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const lines: string[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const d = docs[url];
    if (d === undefined) return new Response("nope", { status: 404 });
    if (typeof d === "function") return (d as (i: RequestInit | undefined) => Response)(init);
    return Response.json(d);
  }) as typeof globalThis.fetch;
  const c = resolveConfig({ ...tippingCo("https://tipping.example", false), fetch,
    resolveHost: async () => ["93.184.216.34"], log: createLogger("company", (l) => lines.push(l)), ...over });
  return { verify: createAgentVerifier(c), calls, lines };
}

async function rejects(p: Promise<unknown>, detail: RegExp) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(PoppyError);
  expect(e).toMatchObject({ code: "invalid_client", status: 401 });
  expect((e as PoppyError).detail).toMatch(detail);
}

const ok = { [ID]: META, "https://agent.example/jwks.json": JWKS };

afterEach(() => { vi.restoreAllMocks(); });

describe("isBlockedAddress", () => {
  test.each([
    ["0.1.2.3", true], ["10.0.0.1", true], ["127.0.0.1", true], ["100.64.0.1", true], ["100.127.255.255", true],
    ["100.63.0.1", false], ["100.128.0.1", false], ["169.254.169.254", true], ["169.253.0.1", false], ["168.254.0.1", false],
    ["172.16.0.1", true], ["172.31.255.255", true], ["172.15.0.1", false], ["172.32.0.1", false], ["171.16.0.1", false],
    ["192.168.1.1", true], ["192.169.1.1", false], ["191.168.1.1", false], ["224.0.0.1", true], ["255.255.255.255", true],
    ["223.255.255.255", false], ["8.8.8.8", false], ["93.184.216.34", false],
    ["::", true], ["::1", true], ["::ffff:10.0.0.1", true], ["::ffff:8.8.8.8", false], ["fc00::1", true], ["fd12::1", true],
    ["fe80::1", true], ["FE80::1", true], ["febf::1", true], ["fec0::1", false], ["ff02::1", true], ["2001:db8::1", false],
    ["2606:4700::fc00", false], ["not-an-ip", true],
  ])("%s → %s", (ip, blocked) => {
    expect(isBlockedAddress(ip)).toBe(blocked);
  });
});

describe("URL and address guard (T-12)", () => {
  test("a non-HTTPS client_id is refused before any fetch", async () => {
    const v = verifier(ok);
    await rejects(v.verify("http://agent.example/agent.json"), /not an allowed URL/);
    expect(v.calls).toHaveLength(0);
  });

  test("an IPv6 loopback literal is refused; a public IPv6 literal is fetched", async () => {
    const v = verifier({});
    await rejects(v.verify("https://[::1]/agent.json"), /\[?::1\]? resolves to a blocked address|::1 resolves/);
    expect(v.calls).toHaveLength(0);
    await rejects(v.verify("https://[2606:4700::1]/agent.json"), /returned 404/);
    expect(v.calls).toHaveLength(1);
  });

  test("dev mode: http://localhost is fetched without DNS; https://localhost still goes through DNS", async () => {
    const resolveHost = vi.fn(async () => ["127.0.0.1"]);
    const dev = verifier({ "http://localhost:8788/agent.json": { client_id: "x" } }, { devAllowHttpLocalhost: true, resolveHost });
    await rejects(dev.verify("http://localhost:8788/agent.json"), /client_id does not match/);
    expect(resolveHost).not.toHaveBeenCalled();
    await rejects(dev.verify("https://localhost:8788/agent.json"), /blocked address/);
    expect(resolveHost).toHaveBeenCalledWith("localhost");
  });

  test("no addresses, a DNS failure, or any one blocked address is refused", async () => {
    await rejects(verifier(ok, { resolveHost: async () => [] }).verify(ID), /cannot resolve agent.example/);
    await rejects(verifier(ok, { resolveHost: async () => { throw new Error("ENOTFOUND"); } }).verify(ID), /cannot resolve/);
    await rejects(verifier(ok, { resolveHost: async () => ["93.184.216.34", "10.0.0.1"] }).verify(ID),
      /agent.example resolves to a blocked address/);
  });

  test("the default resolver is used when none is configured (localhost resolves to loopback)", async () => {
    const c = resolveConfig({ ...tippingCo("https://tipping.example", false), fetch: (async () => Response.json({})) as typeof fetch });
    await rejects(createAgentVerifier(c)("https://localhost/agent.json"), /blocked address/);
  });
});

describe("fetch limits", () => {
  test("fetches with no redirects, a timeout and Accept: application/json", async () => {
    const v = verifier(ok);
    await v.verify(ID);
    expect(v.calls[0]!.init).toMatchObject({ redirect: "error", headers: { accept: "application/json" } });
    expect(v.calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
  });

  test("a network error, a 404, a non-JSON content type or invalid JSON", async () => {
    await rejects(verifier({ [ID]: () => { throw new Error("boom"); } }).verify(ID), /fetch failed for .*boom/);
    await rejects(verifier({}).verify(ID), /agent.json returned 404/);
    await rejects(verifier({ [ID]: () => new Response("{}", { headers: { "content-type": "text/html" } }) }).verify(ID),
      /is not application\/json/);
    await rejects(verifier({ [ID]: () => new Response("{}", { headers: { "content-type": "text/application/json" } }) })
      .verify(ID), /is not application\/json/);
    await rejects(verifier({ [ID]: () => new Response("{nope", { headers: { "content-type": "application/json" } }) })
      .verify(ID), /is not valid JSON/);
  });

  test("structured JSON types like application/jwk-set+json are accepted", async () => {
    const v = verifier({ [ID]: META, "https://agent.example/jwks.json": () => new Response(JSON.stringify(JWKS),
      { headers: { "content-type": "application/jwk-set+json" } }) });
    await v.verify(ID);
  });

  test("64 KB limit, by Content-Length and by actual size", async () => {
    const json = (body: string, headers: Record<string, string> = {}) => () =>
      new Response(body, { headers: { "content-type": "application/json", ...headers } });
    await rejects(verifier({ [ID]: json("{}", { "content-length": "65537" }) }).verify(ID), /too large/);
    const big = JSON.stringify({ pad: "x".repeat(65536) });
    await rejects(verifier({ [ID]: json(big) }).verify(ID), /too large/);
    // Exactly 64 KB is fine (it then fails on content, not size).
    const exact = JSON.stringify({ pad: "x".repeat(65536 - 10) });
    expect(exact.length).toBe(65536);
    await rejects(verifier({ [ID]: json(exact, { "content-length": "65536" }) }).verify(ID), /client_id does not match/);
  });
});

describe("metadata checks (spec 4.1)", () => {
  const meta = (over: Record<string, unknown>) => verifier({ ...ok, [ID]: { ...META, ...over } }).verify(ID);

  test("not an object", async () => {
    await rejects(verifier({ [ID]: null }).verify(ID), /metadata is not an object/);
    await rejects(verifier({ [ID]: "str" }).verify(ID), /metadata is not an object/);
  });
  test("client_id mismatch", () => rejects(meta({ client_id: "https://evil.example/agent.json" }), /client_id does not match the URL/));
  test("jwks_uri missing, not a string or not HTTPS", async () => {
    await rejects(meta({ jwks_uri: undefined }), /jwks_uri missing or not HTTPS/);
    await rejects(meta({ jwks_uri: 5 }), /jwks_uri missing or not HTTPS/);
    await rejects(meta({ jwks_uri: "http://agent.example/jwks.json" }), /jwks_uri missing or not HTTPS/);
  });
  test("jwks_uri on another host", () => rejects(meta({ jwks_uri: "https://cdn.example/jwks.json" }),
    /jwks_uri is not on the client_id host/));
  test("redirect_uris: not a list, a non-string, http, or another host", async () => {
    for (const r of ["https://agent.example/cb", [5], ["http://agent.example/cb"], ["https://evil.example/cb"],
      ["https://agent.example/cb", "https://evil.example/cb"]]) {
      await rejects(meta({ redirect_uris: r }), /redirect_uris must be HTTPS URLs on the client_id host/);
    }
  });
  test("several valid redirect_uris are fine", async () => {
    await meta({ redirect_uris: ["https://agent.example/a", "https://agent.example/b"] });
  });
  test("token_endpoint_auth_method must be private_key_jwt if present", async () => {
    await rejects(meta({ token_endpoint_auth_method: "client_secret_basic" }), /must be private_key_jwt/);
    await meta({ token_endpoint_auth_method: undefined });
  });
  test("jwks: missing keys, a private key or a symmetric key, even alongside public ones", async () => {
    const jwks = (j: unknown) => verifier({ [ID]: META, "https://agent.example/jwks.json": j }).verify(ID);
    await rejects(jwks(null), /jwks has no keys/);
    await rejects(jwks({ keys: "x" }), /jwks has no keys/);
    await rejects(jwks({ keys: [...JWKS.keys, { ...JWKS.keys[0], d: "priv" }] }), /jwks contains a private key/);
    await rejects(jwks({ keys: [...JWKS.keys, { kty: "oct", k: "c2VjcmV0" }] }), /jwks contains a private key/);
  });
});

describe("cache", () => {
  test("a verified agent is cached for 60 s; fresh: true refetches", async () => {
    const v = verifier(ok);
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    await v.verify(ID);
    await v.verify(ID);
    expect(v.calls).toHaveLength(2); // metadata + jwks, once
    spy.mockReturnValue(now + 59_999);
    await v.verify(ID);
    expect(v.calls).toHaveLength(2);
    spy.mockReturnValue(now + 60_000);
    await v.verify(ID);
    expect(v.calls).toHaveLength(4);
    await v.verify(ID, { fresh: true });
    expect(v.calls).toHaveLength(6);
  });

  test("a failed verification isn't cached, and success is logged", async () => {
    const v = verifier({ [ID]: META });
    await rejects(v.verify(ID), /returned 404/);
    expect(v.lines).toEqual([]);
    const good = verifier(ok);
    await good.verify(ID);
    expect(good.lines).toEqual([`[company] agent.verified client_id=${ID} client_name=A`]);
  });
});
