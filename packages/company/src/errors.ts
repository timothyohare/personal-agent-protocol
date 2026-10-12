import type { Context } from "hono";
import { PoppyError } from "poppy-core";

export const oauthError = (code: string, status: number, detail?: string) => new PoppyError(code, status, detail);

/** Writes an OAuth error body. Detail goes in error_description; it never contains secrets. */
export function errorResponse(c: Context, e: PoppyError, headers: Record<string, string> = {}): Response {
  const body: Record<string, string> = { error: e.code };
  if (e.detail) body.error_description = e.detail;
  return c.json(body, e.status as 400, { "cache-control": "no-store", ...headers });
}
