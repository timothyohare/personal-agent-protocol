/** Parses `WWW-Authenticate: DPoP error="…", scope="…"` into its parameters. */
export function parseWwwAuthenticate(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const m of header.matchAll(/([a-z_]+)="([^"]*)"/gi)) out[m[1]!.toLowerCase()] = m[2]!;
  return out;
}
