import { isAllowedUrl, PoppyError } from "poppy-core";

export type Fetch = typeof fetch;

const MAX_REDIRECTS = 5;

/**
 * GETs JSON, following redirects by hand so every hop can be checked: each must be
 * HTTPS (or http://localhost in dev mode), per spec 3.
 */
export async function getJson(
  url: string, opts: { fetch: Fetch; allowHttpLocalhost: boolean },
): Promise<{ body: unknown; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedUrl(current, opts.allowHttpLocalhost)) {
      throw new PoppyError("discovery_failed", 0, `refusing non-HTTPS URL ${current}`);
    }
    const res = await opts.fetch(current, {
      redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new PoppyError("discovery_failed", 0, `redirect without location from ${current}`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) throw new PoppyError("discovery_failed", 0, `${current} returned ${res.status}`);
    return { body: await res.json(), finalUrl: current };
  }
  throw new PoppyError("discovery_failed", 0, "too many redirects");
}
