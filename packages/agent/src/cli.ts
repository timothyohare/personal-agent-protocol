// The personal agent CLI. Narrated protocol events go to stderr; results go to stdout.
import { PoppyError } from "poppy-core";
import type { CompanyClient } from "./company.ts";
import { agentConfigFromEnv, clientFromConfig } from "./config.ts";

export const USAGE = `usage: agent <command>
  discover                 fetch and check the company's Poppy documents
  session                  start a signed-out Session
  fixtures [round]         GET /api/fixtures
  ladder                   GET /api/ladder
  call METHOD PATH [JSON]  call any API path`;

export async function runCli(argv: string[], client: CompanyClient, out: (s: string) => void): Promise<number> {
  const [cmd, ...args] = argv;
  const print = (v: unknown) => out(JSON.stringify(v, null, 2));
  const show = (r: { status: number; body: unknown; error?: string }) => {
    print(r.error ? { status: r.status, error: r.error } : r.body);
    return r.status < 400 ? 0 : 1;
  };
  switch (cmd) {
    case "discover": {
      const d = await client.discovered();
      print({ domain: d.domain, name: d.poppy.organization.name, issuer: d.metadata.issuer,
        scopes: d.poppy.auth.direct?.scopes ?? [] });
      return 0;
    }
    case "session": {
      const s = await client.startSession();
      print({ session_id: s.sessionId, signed_in: s.signedIn, scope: s.scope });
      return 0;
    }
    case "fixtures":
      return show(await client.call("GET", args[0] ? `/api/fixtures?round=${encodeURIComponent(args[0])}` : "/api/fixtures"));
    case "ladder":
      return show(await client.call("GET", "/api/ladder"));
    case "call": {
      const [method, path, body] = args;
      if (!method || !path) break;
      return show(await client.call(method.toUpperCase(), path, body ? JSON.parse(body) : undefined));
    }
  }
  out(USAGE);
  return 2;
}

if (import.meta.main) {
  try {
    const client = await clientFromConfig(agentConfigFromEnv());
    process.exitCode = await runCli(process.argv.slice(2), client, (s) => console.log(s));
  } catch (e) {
    console.error(e instanceof PoppyError ? `error: ${e.message}` : e);
    process.exitCode = 1;
  }
}
