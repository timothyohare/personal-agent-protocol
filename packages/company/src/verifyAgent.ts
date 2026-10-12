// Fetching and checking agent metadata (spec 4.1), with SSRF guards (SecurityReview T-12).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";
import { isAllowedUrl, isLocalHostname } from "poppy-core";
import type { ResolvedConfig } from "./config.ts";
import { oauthError } from "./errors.ts";

export interface AgentMetadata {
  client_id: string;
  client_name?: string;
  jwks_uri: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
}

export interface VerifiedAgent {
  meta: AgentMetadata;
  jwks: JWTVerifyGetKey;
}

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 3000;
const CACHE_MS = 60_000;

const invalidClient = (detail: string) => oauthError("invalid_client", 401, detail);

/** True for addresses an outbound fetch must never reach: loopback, private, link-local, etc. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return /^(fc|fd|fe[89ab]|ff)/.test(s);
  }
  return true;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true })).map((a) => a.address);
}

/** Refuses URLs that aren't HTTPS, or whose host resolves to an internal address. */
async function guardUrl(url: string, c: ResolvedConfig): Promise<URL> {
  if (!isAllowedUrl(url, c.devAllowHttpLocalhost)) throw invalidClient(`not an allowed URL: ${url}`);
  const u = new URL(url);
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  // The dev exception covers http://localhost only, and only when the flag is set.
  if (c.devAllowHttpLocalhost && u.protocol === "http:" && isLocalHostname(u.hostname)) return u;
  const addrs = isIP(hostname) ? [hostname] : await (c.resolveHost ?? defaultResolve)(hostname).catch(() => []);
  if (addrs.length === 0) throw invalidClient(`cannot resolve ${hostname}`);
  if (addrs.some(isBlockedAddress)) throw invalidClient(`${hostname} resolves to a blocked address`);
  return u;
}

async function fetchJson(url: string, c: ResolvedConfig): Promise<unknown> {
  await guardUrl(url, c);
  let res: Response;
  try {
    res = await c.fetch(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" } });
  } catch (e) {
    throw invalidClient(`fetch failed for ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) throw invalidClient(`${url} returned ${res.status}`);
  if (!/^application\/([a-z.+-]*\+)?json\b/i.test(res.headers.get("content-type") ?? "")) {
    throw invalidClient(`${url} is not application/json`);
  }
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw invalidClient(`${url} is too large`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw invalidClient(`${url} is too large`);
  try {
    return JSON.parse(text);
  } catch {
    throw invalidClient(`${url} is not valid JSON`);
  }
}

const sameHost = (a: string, b: string) => new URL(a).host === new URL(b).host;

export function createAgentVerifier(c: ResolvedConfig) {
  const cache = new Map<string, { agent: VerifiedAgent; until: number }>();

  /** Fetches and validates the Client ID Metadata Document and JWKS for `clientId`. */
  return async function verifyAgent(clientId: string, opts: { fresh?: boolean } = {}): Promise<VerifiedAgent> {
    const hit = cache.get(clientId);
    if (!opts.fresh && hit && hit.until > Date.now()) return hit.agent;

    const meta = await fetchJson(clientId, c) as Partial<AgentMetadata> | null;
    if (!meta || typeof meta !== "object") throw invalidClient("metadata is not an object");
    if (meta.client_id !== clientId) throw invalidClient("metadata client_id does not match the URL");
    if (typeof meta.jwks_uri !== "string" || !isAllowedUrl(meta.jwks_uri, c.devAllowHttpLocalhost)) {
      throw invalidClient("jwks_uri missing or not HTTPS");
    }
    // Stricter than the spec's same-domain rule: same host (S4 notes, A-19).
    if (!sameHost(meta.jwks_uri, clientId)) throw invalidClient("jwks_uri is not on the client_id host");
    if (!Array.isArray(meta.redirect_uris) || meta.redirect_uris.some((r) => typeof r !== "string"
      || !isAllowedUrl(r, c.devAllowHttpLocalhost) || !sameHost(r, clientId))) {
      throw invalidClient("redirect_uris must be HTTPS URLs on the client_id host");
    }
    if (meta.token_endpoint_auth_method !== undefined && meta.token_endpoint_auth_method !== "private_key_jwt") {
      throw invalidClient("token_endpoint_auth_method must be private_key_jwt");
    }
    const jwks = await fetchJson(meta.jwks_uri, c) as JSONWebKeySet;
    if (!jwks || !Array.isArray(jwks.keys)) throw invalidClient("jwks has no keys");
    if (jwks.keys.some((k) => "d" in k || k.kty === "oct")) throw invalidClient("jwks contains a private key");

    const agent = { meta: meta as AgentMetadata, jwks: createLocalJWKSet(jwks) };
    cache.set(clientId, { agent, until: Date.now() + CACHE_MS });
    c.log.event("agent.verified", { client_id: clientId, client_name: meta.client_name });
    return agent;
  };
}

export type AgentVerifier = ReturnType<typeof createAgentVerifier>;
