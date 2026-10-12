// Discovery (spec 3, PRD F1).
import { PoppyError, type Logger, silentLogger } from "poppy-core";
import { getJson, type Fetch } from "./http.ts";

export const SUPPORTED_MAJOR_VERSION = 0;

export interface PoppyDocument {
  protocol_version: string;
  organization: { name: string; domain: string };
  auth: {
    issuer: string;
    direct?: { scopes?: string[] };
    custom_scopes?: Record<string, string>;
  };
  apis?: { type: string; url: string; description?: string }[];
}

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  poppy_domains: string[];
}

export interface Discovery {
  /** The host the user asked for. */
  domain: string;
  poppy: PoppyDocument;
  metadata: AuthServerMetadata;
}

export interface DiscoverOptions {
  fetch?: Fetch;
  allowHttpLocalhost?: boolean;
  log?: Logger;
}

const fail = (detail: string) => new PoppyError("discovery_failed", 0, detail);
const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, "");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The RFC 8414 metadata URL for an issuer: the well-known path goes between host and path. */
export function metadataUrl(issuer: string): string {
  const u = new URL(issuer);
  const path = u.pathname === "/" ? "" : u.pathname;
  return `${u.origin}/.well-known/oauth-authorization-server${path}`;
}

/** Normalises what the user typed ("tipping.ohare.id.au", or a URL) to a host. */
export function hostOf(input: string): string {
  return (/^[a-z]+:\/\//i.test(input) ? new URL(input) : new URL(`https://${input}`)).host.toLowerCase();
}

function scheme(host: string, allowHttpLocalhost: boolean): string {
  const hostname = new URL(`http://${host}`).hostname;
  return allowHttpLocalhost && ["localhost", "127.0.0.1", "[::1]"].includes(hostname) ? "http" : "https";
}

function parsePoppy(body: unknown): PoppyDocument {
  if (!isObject(body)) throw fail("poppy.json is not an object");
  const { protocol_version: v, organization: org, auth } = body;
  if (typeof v !== "string" || !/^\d+(\.\d+)*$/.test(v)) throw fail("protocol_version missing or malformed");
  if (Number(v.split(".")[0]) !== SUPPORTED_MAJOR_VERSION) throw fail(`unsupported protocol_version ${v}`);
  if (!isObject(org) || typeof org.domain !== "string" || typeof org.name !== "string") {
    throw fail("organization missing");
  }
  if (!isObject(auth) || typeof auth.issuer !== "string") throw fail("auth.issuer missing");
  return body as unknown as PoppyDocument;
}

function parseMetadata(body: unknown): AuthServerMetadata {
  if (!isObject(body)) throw fail("metadata is not an object");
  for (const k of ["issuer", "authorization_endpoint", "token_endpoint"]) {
    if (typeof body[k] !== "string") throw fail(`metadata ${k} missing`);
  }
  if (!Array.isArray(body.poppy_domains)) throw fail("metadata poppy_domains missing");
  return body as unknown as AuthServerMetadata;
}

/** Discovers a company and checks the bindings between its documents (F1, S4 G11). */
export async function discover(input: string, opts: DiscoverOptions = {}): Promise<Discovery> {
  const allowHttpLocalhost = opts.allowHttpLocalhost ?? false;
  const http = { fetch: opts.fetch ?? globalThis.fetch, allowHttpLocalhost };
  const log = opts.log ?? silentLogger;
  const domain = hostOf(input);

  const { body } = await getJson(`${scheme(domain, allowHttpLocalhost)}://${domain}/.well-known/poppy.json`, http);
  const poppy = parsePoppy(body);
  // Compare with the host the user asked for, not the post-redirect host (spec 3).
  if (stripWww(poppy.organization.domain) !== stripWww(domain)) {
    throw fail(`organization.domain ${poppy.organization.domain} does not match ${domain}`);
  }

  const metadata = parseMetadata((await getJson(metadataUrl(poppy.auth.issuer), http)).body);
  if (metadata.issuer !== poppy.auth.issuer) throw fail(`issuer ${metadata.issuer} != ${poppy.auth.issuer}`);
  if (!metadata.poppy_domains.map(stripWww).includes(stripWww(domain))) {
    throw fail(`poppy_domains does not include ${domain}`);
  }
  log.event("discovered", { domain, issuer: metadata.issuer, name: poppy.organization.name });
  return { domain, poppy, metadata };
}
