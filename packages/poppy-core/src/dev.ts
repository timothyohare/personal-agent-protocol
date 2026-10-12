// The dev-only localhost exception (SecurityReview T-12). The spec requires HTTPS; the
// local acceptance run uses http://localhost, allowed only when this flag is set.

export const DEV_FLAG = "POPPY_DEV_ALLOW_HTTP_LOCALHOST";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Reads the dev flag. Refuses to start if it is set in production. */
export function devAllowHttpLocalhost(env: Record<string, string | undefined> = process.env): boolean {
  const on = env[DEV_FLAG] === "1";
  if (on && env.NODE_ENV === "production") {
    throw new Error(`${DEV_FLAG} must not be set when NODE_ENV=production`);
  }
  return on;
}

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

/** True for an https URL, or for http://localhost when the dev flag is on. */
export function isAllowedUrl(url: string | URL, allowHttpLocalhost: boolean): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return allowHttpLocalhost && u.protocol === "http:" && isLocalHostname(u.hostname);
}
