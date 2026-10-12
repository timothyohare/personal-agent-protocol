// The personal agent CLI. Narrated protocol events go to stderr; results go to stdout.
import { createInterface } from "node:readline";
import { PoppyError } from "poppy-core";
import type { CallResult, CompanyClient } from "./company.ts";
import { agentConfigFromEnv, clientFromConfig } from "./config.ts";
import { startLoopback } from "./loopback.ts";

export const DEFAULT_SCOPES = ["poppy:read", "poppy:write", "standings"];

/** Hooks for the parts of sign-in that involve the user, replaced in tests. */
export interface CliIo {
  out: (s: string) => void;
  /** Tells the user to open the URL. The user signs in themselves (spec 4.4). */
  showSignInUrl: (url: string) => void;
  /** A callback URL pasted by the user, as a fallback if the loopback hop is blocked (S3). */
  pastedCallback?: () => Promise<string>;
}

function stdinLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); }));
}

async function signIn(client: CompanyClient, scopes: string[], io: CliIo) {
  const lb = await startLoopback();
  try {
    io.showSignInUrl(await client.beginSignIn(scopes, { loopbackPort: lb.port }));
    const waits: Promise<string | URLSearchParams>[] = [lb.result];
    if (io.pastedCallback) waits.push(io.pastedCallback());
    return await client.completeSignIn(await Promise.race(waits));
  } finally {
    lb.close();
  }
}

export const USAGE = `usage: agent <command>
  discover                 fetch and check the company's Poppy documents
  session                  start a signed-out Session
  fixtures [round]         GET /api/fixtures
  ladder                   GET /api/ladder
  tips                     your tips (signs in if needed)
  tip TEAM [ROUND]         tip TEAM to win its match this round (or ROUND)
  score                    your score (custom scope: standings)
  signin [scope ...]       Direct Sign-In in your browser (default: all scopes)
  status                   show the Session and whether an Account Token is stored
  call METHOD PATH [JSON]  call any API path`;

type Call = () => Promise<CallResult>;

/**
 * Runs an API call. On 403 sign_in_required it asks the user to sign in, then retries once.
 * On insufficient_scope it reports the missing scope instead (the user unticked it).
 */
async function withSignIn(client: CompanyClient, io: CliIo, call: Call): Promise<CallResult> {
  const r = await call();
  if (r.error !== "sign_in_required") return r;
  io.out("This needs you to sign in to the company.");
  await signIn(client, DEFAULT_SCOPES, io);
  return call();
}

export async function runCli(argv: string[], client: CompanyClient, ioOrOut: CliIo | ((s: string) => void)): Promise<number> {
  const io: CliIo = typeof ioOrOut === "function"
    ? { out: ioOrOut, showSignInUrl: (u) => ioOrOut(`Open this URL to sign in: ${u}`) } : ioOrOut;
  const out = io.out;
  const [cmd, ...args] = argv;
  const print = (v: unknown) => out(JSON.stringify(v, null, 2));
  const show = (r: CallResult) => {
    if (r.error === "insufficient_scope") {
      out(`You haven't allowed the "${r.requiredScope}" scope. Run: signin ${r.requiredScope}`);
      return 1;
    }
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
    case "tips":
      return show(await withSignIn(client, io, () => client.call("GET", "/api/me/tips")));
    case "score":
      return show(await withSignIn(client, io, () => client.call("GET", "/api/me/score")));
    case "tip": {
      const [team, round] = args;
      if (!team) break;
      const f = await client.call("GET", round ? `/api/fixtures?round=${encodeURIComponent(round)}` : "/api/fixtures");
      if (f.status !== 200) return show(f);
      const fixtures = (f.body as { fixtures: { id: string; home: string; away: string }[] }).fixtures;
      const want = team.toLowerCase();
      const match = fixtures.find((x) => [x.home, x.away].some((t) => t.toLowerCase() === want))
        ?? fixtures.find((x) => [x.home, x.away].some((t) => t.toLowerCase().includes(want)));
      if (!match) {
        out(`${team} isn't playing in that round.`);
        return 1;
      }
      const name = [match.home, match.away].find((t) => t.toLowerCase().includes(want))!;
      return show(await withSignIn(client, io,
        () => client.call("POST", "/api/me/tips", { fixture_id: match.id, team: name })));
    }
    case "signin": {
      const s = await signIn(client, args.length ? args : DEFAULT_SCOPES, io);
      print({ signed_in: s.signedIn, session_id: s.sessionId, scope: s.scope });
      return 0;
    }
    case "status": {
      const at = await client.accountToken();
      print({ session: client.session ? { session_id: client.session.sessionId, signed_in: client.session.signedIn,
        scope: client.session.scope } : null, account_token: at ? { stored: true, scope: at.scope } : { stored: false } });
      return 0;
    }
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
    process.exitCode = await runCli(process.argv.slice(2), client, {
      out: (s) => console.log(s),
      showSignInUrl: (u) => console.error(`\nOpen this URL in your browser and sign in:\n\n  ${u}\n`),
      pastedCallback: process.stdin.isTTY
        ? () => stdinLine("(If the browser can't reach this terminal, paste the final URL here) ") : undefined,
    });
    process.exit();
  } catch (e) {
    console.error(e instanceof PoppyError ? `error: ${e.message}` : e);
    process.exitCode = 1;
  }
}
