import { describe, expect, test } from "vitest";
import { createCompany, tippingCo } from "company";
import { discover, hostOf, metadataUrl } from "../src/index.ts";
import { PoppyError, fetchRouter, staticHost } from "poppy-core";

const HOST = "tipping.ohare.id.au";
const ISS = `https://${HOST}`;
const company = createCompany(tippingCo(ISS, false)).app;

const poppy = (over: Record<string, unknown> = {}) => ({
  protocol_version: "0.1",
  organization: { name: "Tipping Co", domain: HOST },
  auth: { issuer: ISS },
  ...over,
});
const meta = (over: Record<string, unknown> = {}) => ({
  issuer: ISS, authorization_endpoint: `${ISS}/oauth/authorize`, token_endpoint: `${ISS}/oauth/token`,
  poppy_domains: [HOST], ...over,
});
const site = (p: unknown, m: unknown = meta()) =>
  fetchRouter({ [HOST]: staticHost({ "/.well-known/poppy.json": p, "/.well-known/oauth-authorization-server": m }) });

async function fails(p: Promise<unknown>, re: RegExp) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(PoppyError);
  expect((e as PoppyError).code).toBe("discovery_failed");
  expect((e as Error).message).toMatch(re);
}

describe("discover: accepts", () => {
  test("the real Tipping Co app", async () => {
    const d = await discover(HOST, { fetch: fetchRouter({ [HOST]: company }) });
    expect(d.domain).toBe(HOST);
    expect(d.metadata.token_endpoint).toBe(`${ISS}/oauth/token`);
    expect(d.poppy.organization.name).toBe("Tipping Co");
  });

  test("a URL as input", async () => {
    await discover(`https://${HOST}/anything`, { fetch: site(poppy()) });
  });

  test("a leading www. on either side (spec 3)", async () => {
    await discover(`www.${HOST}`, { fetch: fetchRouter({ [`www.${HOST}`]: staticHost({
      "/.well-known/poppy.json": poppy() }), [HOST]: staticHost({ "/.well-known/oauth-authorization-server": meta() }) }) });
    await discover(HOST, { fetch: site(poppy({ organization: { name: "T", domain: `www.${HOST}` } })) });
  });

  test("unknown fields and extensions are ignored (S4 G11)", async () => {
    await discover(HOST, { fetch: site(poppy({ "example.com/ext": { x: 1 }, future: true }), meta({ extra: 1 })) });
  });

  test("a minor version change (0.2)", async () => {
    await discover(HOST, { fetch: site(poppy({ protocol_version: "0.2" })) });
  });

  test("an HTTPS redirect, still matched against the requested host", async () => {
    const fetch = fetchRouter({
      [HOST]: staticHost({ "/.well-known/poppy.json": { redirect: "https://cdn.example/p.json" },
        "/.well-known/oauth-authorization-server": meta() }),
      "cdn.example": staticHost({ "/p.json": poppy() }),
    });
    await discover(HOST, { fetch });
  });

  test("http://localhost in dev mode, with the port in the domain", async () => {
    const local = createCompany(tippingCo("http://localhost:8787", true)).app;
    const d = await discover("localhost:8787", { fetch: fetchRouter({ "localhost:8787": local }), allowHttpLocalhost: true });
    expect(d.metadata.issuer).toBe("http://localhost:8787");
  });
});

describe("discover: rejects (F1)", () => {
  test("organization.domain mismatch", async () => {
    await fails(discover(HOST, { fetch: site(poppy({ organization: { name: "T", domain: "evil.example" } })) }),
      /does not match/);
  });

  test("a subdomain is not the same domain", async () => {
    await fails(discover(HOST, { fetch: site(poppy({ organization: { name: "T", domain: `x.${HOST}` } })) }),
      /does not match/);
  });

  test("issuer mismatch", async () => {
    await fails(discover(HOST, { fetch: site(poppy(), meta({ issuer: "https://evil.example" })) }), /issuer/);
  });

  test("issuer differing only by a trailing slash", async () => {
    await fails(discover(HOST, { fetch: site(poppy(), meta({ issuer: `${ISS}/` })) }), /issuer/);
  });

  test("poppy_domains missing the domain", async () => {
    await fails(discover(HOST, { fetch: site(poppy(), meta({ poppy_domains: ["other.example"] })) }), /poppy_domains/);
  });

  test("poppy_domains absent", async () => {
    await fails(discover(HOST, { fetch: site(poppy(), meta({ poppy_domains: undefined })) }), /poppy_domains/);
  });

  test("an unsupported major protocol_version", async () => {
    await fails(discover(HOST, { fetch: site(poppy({ protocol_version: "1.0" })) }), /unsupported/);
  });

  test("a malformed protocol_version", async () => {
    await fails(discover(HOST, { fetch: site(poppy({ protocol_version: "zero" })) }), /malformed/);
    await fails(discover(HOST, { fetch: site(poppy({ protocol_version: 0.1 })) }), /malformed/);
  });

  test("missing organization or auth.issuer", async () => {
    await fails(discover(HOST, { fetch: site(poppy({ organization: undefined })) }), /organization/);
    await fails(discover(HOST, { fetch: site(poppy({ auth: {} })) }), /issuer/);
    await fails(discover(HOST, { fetch: site([]) }), /not an object/);
  });

  test("metadata missing token_endpoint", async () => {
    await fails(discover(HOST, { fetch: site(poppy(), meta({ token_endpoint: undefined })) }), /token_endpoint/);
  });

  test("a redirect to http", async () => {
    const fetch = fetchRouter({ [HOST]: staticHost({ "/.well-known/poppy.json": { redirect: "http://cdn.example/p" } }) });
    await fails(discover(HOST, { fetch }), /non-HTTPS/);
  });

  test("a redirect loop", async () => {
    const fetch = fetchRouter({ [HOST]: staticHost({ "/.well-known/poppy.json": { redirect: "/.well-known/poppy.json" } }) });
    await fails(discover(HOST, { fetch }), /too many/);
  });

  test("an http issuer outside dev mode", async () => {
    await fails(discover(HOST, { fetch: site(poppy({ auth: { issuer: "http://tipping.ohare.id.au" } })) }), /non-HTTPS/);
  });

  test("localhost without the dev flag uses https, and http localhost is refused", async () => {
    await fails(discover(HOST, { fetch: site(poppy({ auth: { issuer: "http://localhost:8787" } })) }), /non-HTTPS/);
  });

  test("a 404", async () => {
    await fails(discover(HOST, { fetch: fetchRouter({ [HOST]: staticHost({}) }) }), /404/);
  });
});

test("metadataUrl follows RFC 8414", () => {
  expect(metadataUrl("https://a.example")).toBe("https://a.example/.well-known/oauth-authorization-server");
  expect(metadataUrl("https://a.example/tenant")).toBe("https://a.example/.well-known/oauth-authorization-server/tenant");
});

test("hostOf", () => {
  expect(hostOf("Tipping.Ohare.id.au")).toBe("tipping.ohare.id.au");
  expect(hostOf("https://tipping.ohare.id.au/x")).toBe("tipping.ohare.id.au");
  expect(hostOf("localhost:8787")).toBe("localhost:8787");
});
