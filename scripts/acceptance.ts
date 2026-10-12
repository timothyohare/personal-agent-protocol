// The acceptance flow, run by gate-verify against the booted services (scripts/dev-local.ts).
// Each stage narrates one line per protocol step and exits non-zero on any failure.
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { JWK } from "jose";
import { CompanyClient, FileVault, loadIdentity, startLoopback } from "agent";
import { TestBrowser, parseForm, userSignsIn } from "../test-support/browser.ts";
import { createLogger } from "poppy-core";
import { keysDir } from "./keys.ts";

process.env.POPPY_DEV_ALLOW_HTTP_LOCALHOST = "1";
const COMPANY = process.env.POPPY_COMPANY ?? "localhost:8787";
const AGENT = process.env.AGENT_BASE_URL ?? "http://localhost:8788";

const lines: string[] = [];
const sink = (l: string) => {
  lines.push(l);
  console.log(l);
  if (process.env.POPPY_LOG_FILE) appendFileSync(process.env.POPPY_LOG_FILE, `${l}\n`);
};
const log = createLogger("agent", sink);
const step = (msg: string) => sink(`[acceptance] ${msg}`);
/** Every secret value seen during the run; none may appear in any output (N5). */
const secrets = new Set<string>();

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${msg}`);
  step(`✓ ${msg}`);
}

async function newClient(dir = mkdtempSync(join(tmpdir(), "poppy-acceptance-"))): Promise<CompanyClient> {
  const privateJwk = JSON.parse(readFileSync(join(keysDir(), "agent-signing.private.json"), "utf8")) as JWK;
  const identity = await loadIdentity(`${AGENT}/agent.json`, privateJwk);
  return new CompanyClient(COMPANY, {
    identity, vault: new FileVault(join(dir, "vault.json"), join(dir, "vault.key")), allowHttpLocalhost: true, log,
  });
}

/**
 * Milestone 3 sign-in. The harness plays the user in the browser (never the agent library, S4 E4),
 * including the agent host's callback page that forwards the result to the loopback listener.
 */
async function signIn(c: CompanyClient, scopes: string[], untick: string[] = []) {
  const lb = await startLoopback({ timeoutMs: 15_000 });
  const url = await c.beginSignIn(scopes, { loopbackPort: lb.port });
  step(`user opens the authorize URL and signs in as the test user${untick.length ? `, unticking ${untick}` : ""}`);
  const browser = new TestBrowser(fetch);
  const callbackPage = await userSignsIn(browser, url, { untick });
  const f = parseForm(await (await browser.get(callbackPage)).text());
  check(f.action === `http://127.0.0.1:${lb.port}/cb`, "agent host callback page forwards to the loopback listener");
  await fetch(f.action!, { method: "POST", body: new URLSearchParams(f.hidden),
    headers: { "content-type": "application/x-www-form-urlencoded" } });
  const s = await c.completeSignIn(await lb.result);
  secrets.add(s.token);
  const at = await c.accountToken();
  if (at) secrets.add(at.token);
  return s;
}

const stages: Record<string, () => Promise<void>> = {
  /** Milestones 1-2: discovery, a signed-out Session, public APIs with DPoP. */
  async "signed-out"() {
    const c = await newClient();
    const d = await c.discovered();
    check(d.metadata.issuer === `http://${COMPANY}`, `discovered ${d.poppy.organization.name} at ${d.metadata.issuer}`);
    const s = await c.startSession();
    secrets.add(s.token);
    check(!s.signedIn && s.scope.length === 0, `signed-out Session ${s.sessionId}`);
    const f = await c.call("GET", "/api/fixtures");
    check(f.status === 200, "GET /api/fixtures returns 200");
    const l = await c.call("GET", "/api/ladder");
    check(l.status === 200, "GET /api/ladder returns 200");
    const r = await c.startSession({ renew: true });
    secrets.add(r.token);
    check(r.sessionId === s.sessionId, "renewed the same Session");
  },

  /** Milestone 3: Direct Sign-In signs in the current Session and stores an Account Token. */
  async "sign-in"() {
    const c = await newClient();
    const before = await c.startSession();
    secrets.add(before.token);
    const s = await signIn(c, ["poppy:read", "poppy:write", "standings"]);
    check(s.signedIn && s.sessionId === before.sessionId, `Session ${s.sessionId} is signed in`);
    check(s.scope.join(" ") === "poppy:read poppy:write standings", `granted scope: ${s.scope.join(" ")}`);
    check((await c.accountToken()) !== undefined, "Account Token stored in the vault");
    const narrowed = await signIn(await newClient(), ["poppy:read", "poppy:write"], ["poppy:write"]);
    check(narrowed.scope.join(" ") === "poppy:read", "unticked poppy:write is not granted");
  },

  /** Milestone 3: GET 403 → sign in → POST a tip → GET shows it. Plus insufficient_scope. */
  async tips() {
    const c = await newClient();
    const denied = await c.call("GET", "/api/me/tips");
    check(denied.status === 403 && denied.error === "sign_in_required", "signed out: GET /api/me/tips is 403 sign_in_required");
    await signIn(c, ["poppy:read", "poppy:write", "standings"]);
    const post = await c.call("POST", "/api/me/tips", { fixture_id: "r27-1", team: "Storm" });
    check(post.status === 201, "POST /api/me/tips (Storm, round 27) returns 201");
    const get = await c.call("GET", "/api/me/tips");
    const tips = (get.body as { tips: { fixture_id: string; team: string }[] }).tips;
    check(tips.some((t) => t.fixture_id === "r27-1" && t.team === "Storm"), "GET /api/me/tips shows the tip");
    const score = await c.call("GET", "/api/me/score");
    check(score.status === 200, "GET /api/me/score works with the custom standings scope");

    const narrow = await newClient();
    await signIn(narrow, ["poppy:read", "poppy:write"], ["poppy:write"]);
    const r = await narrow.call("POST", "/api/me/tips", { fixture_id: "r27-1", team: "Storm" });
    check(r.status === 403 && r.error === "insufficient_scope" && r.requiredScope === "poppy:write",
      "without poppy:write: POST is 403 insufficient_scope, scope=poppy:write");
  },

  /** Milestone 4: kill the agent, resume signed in from the Account Token, sign out, then 403. */
  async "resume-signout"() {
    const dir = mkdtempSync(join(tmpdir(), "poppy-acceptance-"));
    const first = await newClient(dir);
    await signIn(first, ["poppy:read", "poppy:write"]);
    await first.call("POST", "/api/me/tips", { fixture_id: "r27-3", team: "Roosters" });
    step("agent process killed; a new one starts with the same vault");
    const second = await newClient(dir);
    const tips = await second.call("GET", "/api/me/tips");
    check(tips.status === 200 && second.session?.signedIn === true,
      "the new process is signed in from the Account Token, without the user");
    secrets.add(second.session!.token);
    const at = (await second.accountToken())!.token;
    check(await second.signOut(), "signed out: Account Token revoked");
    const after = await second.call("GET", "/api/me/tips");
    check(after.status === 403 && after.error === "sign_in_required", "after sign-out: GET /api/me/tips is 403 sign_in_required");
    // The stale Account Token no longer works at the token endpoint.
    const third = await newClient(dir);
    await third.discovered();
    const refused = await third.tokenRequest(async () => ({ grant_type: "refresh_token", refresh_token: at }))
      .then(() => "accepted", (e: { code?: string }) => e.code);
    check(refused === "invalid_grant", "refresh with the revoked Account Token is invalid_grant");
    check((await third.call("GET", "/api/fixtures")).status === 200, "public APIs still work signed out");
  },
};

const only = process.argv.slice(2);
let failed = false;
for (const [name, run] of Object.entries(stages)) {
  if (only.length && !only.includes(name)) continue;
  step(`stage ${name}`);
  try {
    await run();
  } catch (e) {
    failed = true;
    step(`✗ stage ${name}: ${(e as Error).message}`);
  }
}
const leaked = [...secrets].filter((v) => lines.some((l) => l.includes(v)));
if (leaked.length) {
  failed = true;
  step(`✗ ${leaked.length} secret value(s) appeared in the output`);
} else {
  step(`✓ no secrets in ${lines.length} output lines`);
}
step(failed ? "FAILED" : "PASSED");
process.exit(failed ? 1 : 0);
