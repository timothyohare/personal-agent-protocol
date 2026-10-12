# How to verify: Poppy demonstration

*Draft · 12 October 2026 · Each milestone below is "done" only when its automated gate is green **and** its manual check matches. Paste the gate output into the PR or the checkpoint review.*

`GATES=~/dev/newdev/code-build-harness/harness/gates`

## 0. Standing gates (every task)

| Claim | Command | Passes when |
|---|---|---|
| Lint, types and tests are clean | `node $GATES/ci.mjs --force` | Exit 0 |
| It builds | `node $GATES/ci.mjs --force --full` | Exit 0 |
| It works end to end | `node $GATES/verify.mjs` | Exit 0. Boots company and agent host, runs `scripts/acceptance.ts` and `scripts/attacks.ts` |
| The tests catch regressions | `node $GATES/mutation.mjs` | Score ≥ 80%, and no survivors in the checks listed in SecurityReview section 4 |
| How the harness resolved commands | `node $GATES/resolve-cli.mjs --json` | Every key resolved |

Planned `.claude/harness.json` (created in Task 1):

```json
{
  "lint": "npm run lint",
  "typecheck": "npm run typecheck",
  "build": "npm run build",
  "boot": "npm run dev:local",
  "ready": "http://localhost:8787/.well-known/poppy.json",
  "readyMatch": "protocol_version",
  "acceptance": "npm run acceptance && npm run attacks",
  "mutation": "npx stryker run",
  "env": { "POPPY_DEV_ALLOW_HTTP_LOCALHOST": "1", "NODE_ENV": "development" }
}
```

Local ports: company `http://localhost:8787`, agent host `http://localhost:8788`. From Task 14 on, the public demo runs on AWS Lambda behind CloudFront (`https://tipping.ohare.id.au`, `https://agent.ohare.id.au`, later `https://stats.ohare.id.au`), and the dev flag is **never** set there.

## M1: Static files

**Automated:** `npm test -w company -w agent-host -w agent` (discovery tests, including the 3 rejection cases).

**Manual:**

```bash
curl -s https://tipping.ohare.id.au/.well-known/poppy.json | jq .
curl -s https://tipping.ohare.id.au/.well-known/oauth-authorization-server | jq .
curl -s https://agent.ohare.id.au/agent.json | jq .
curl -s https://agent.ohare.id.au/jwks.json | jq '.keys[] | {kty, crv, kid, has_private: has("d")}'
```

Expect:
- The content matches briefing 9.3 and 9.4.
- `issuer` is identical in both company files.
- `has_private` is `false` for every key.

## M2: Signed-out session

**Automated:** `node $GATES/verify.mjs` (acceptance stage "session" and "fixtures").

**Manual:**

```bash
npm run agent -- discover tipping.ohare.id.au
npm run agent -- fixtures
```

Expect these narrated log lines, and no token values:

```
[agent] discovered Tipping Co (issuer https://tipping.ohare.id.au)
[agent] user id for issuer: loaded (random, per-company)
[company] verified agent https://agent.ohare.id.au/agent.json (kid …)
[company] session ses_… started, signed_in=false, dpop jkt=…
[agent] GET /api/fixtures → 200 (5 fixtures)
```

Spot-check the token response shape (debug flag prints keys only): `access_token, token_type=DPoP, expires_in, scope="", session_id, signed_in=false`.

## M3: Direct Sign-In and writing a tip

**Automated:** acceptance stages "sign-in" (form automation as `test@tipping.example`) and "tips".

**Manual (real browser):**

1. Run `npm run agent -- tips`. Expect `403 sign_in_required`, and the agent offers to sign in.
2. Accept. The browser opens the authorize page. Check:
   - The login form is shown first.
   - The consent page shows **"Tim's Agent"** *and* the host **agent.ohare.id.au**.
   - Each of `poppy:read`, `poppy:write` and `standings` has its own checkbox.
3. Untick `standings` and approve. The agent reports the granted scope without `standings`.
4. Run `npm run agent -- tip --round 32 --team Storm`. Expect `201`.
5. Run `npm run agent -- tips`. The new tip is listed.
6. Run `npm run agent -- score`. Expect `403 insufficient_scope (standings)`.
7. Check the headers:

   ```bash
   curl -sI "https://tipping.ohare.id.au/oauth/authorize?…" | grep -iE 'x-frame-options|content-security-policy'
   ```

   Expect `DENY` and `frame-ancestors 'none'`.

## M4: Account Token reuse and revocation

**Automated:** acceptance stage "lifecycle".

**Manual:**

```bash
npm run agent -- session --drop      # forget the Session Token (keep the Account Token)
npm run agent -- tips                # resumes signed-in via refresh, no browser → 200
npm run agent -- signout             # revokes the Account Token
npm run agent -- tips                # → 403 sign_in_required
```

Expect the company log to show `refresh → session ses_… signed_in=true`, then `revoked account token; signed out 1 session`.

## M5: Attack tests

**Automated:** `npm run attacks`. It prints a table of A-01 to A-24 (SecurityReview section 5), each showing the expected and actual result. Any unexpected success exits non-zero. It also runs inside `gate-verify`.

**Manual spot checks** (with `--keep` so the app stays up):

```bash
node $GATES/verify.mjs --keep
npm run agent -- debug replay-last   # resend the last request byte for byte → 401 invalid_dpop_proof
```

Then open SecurityReview section 7 and tick each item, with evidence.

## M6: LLM in the loop

**Automated:** `npm test -w agent -- tool`. This uses a stubbed model and asserts that no secret patterns appear in any tool output or message (F12), and that A-21 holds.

**Manual:**

```bash
ANTHROPIC_API_KEY=… npm run chat
> What are this round's NRL fixtures?
> Tip the Storm to win this round.
```

Expect:
- The fixtures are answered without asking for sign-in.
- The tip request triggers a sign-in prompt in the browser (if signed out), then a **confirmation question before the POST**.
- `npm run chat -- --dump-transcript` shows no `eyJ`, `ses_`, `code=` or JWK `"d"` values.

## v1.1 additions (Tasks 13–22)

Once Task 13 lands, `.claude/harness.json` adds `"mockAws": "dynamodb-local"`, so `gate-verify` runs against DynamoDB Local. The acceptance script gains these stages:
- `conversation`
- `handoff`
- `direct`
- `mcp`
- `two-companies`

`npm run attacks` grows to cover A-01 to A-40.

### Cloud smoke test (Tasks 14 onward)

```bash
sam validate --lint && sam build && sam deploy
npm run smoke:cloud                                   # v1 flow M1–M4 against the deployed URLs
npm run attacks -- --base https://tipping.ohare.id.au # attack suite against the cloud
```

Expect both to exit 0. Also check:
- The deployed config has no dev flag: `aws lambda get-function-configuration --function-name <company-fn> | jq '.Environment.Variables | has("POPPY_DEV_ALLOW_HTTP_LOCALHOST")'` returns `false`.
- CloudFront forwards the auth headers: a request with a deliberately wrong DPoP proof returns `invalid_dpop_proof`, not `invalid_token` (A-39).

### M7: Conversation with the Claude-backed company agent

**Automated:** acceptance stages `conversation` (echo agent; schema test against briefing 9.8) and the company-agent tests (stubbed model).

**Manual (cloud):**

```bash
npm run agent -- chat-company tipping.ohare.id.au
> Who plays this round?
> Put my tip on the Storm.
```

Expect:
- The first reply arrives as a `message` event with `role: company`, `sender: agent` and `responder: agent`.
- The tip request triggers an `authorization` event (`sign_in_required`) if you're signed out. After sign-in, the company agent asks for confirmation, then submits.
- `npm run agent -- tips` shows the same tip as one made through the API.
- `npm run agent -- chat-company --dump-events` shows a `status` and `responder` on every response, and no tokens.

### M8: Handoff, SSE and direct conversations

**Automated:** acceptance stages `handoff` (operator scripted over HTTP) and `direct`, plus the SSE disconnect test.

**Manual:**
1. In the chat, type `/handoff`. Expect a `state` event with `status: queued`.
2. Open the operator console (`https://tipping.ohare.id.au/operator`), sign in and join. The agent shows a `state` event with `responder: human`.
3. Reply as the operator. The agent shows the message with `sender: human`.
4. From the console, click "Ask to talk to the customer". The agent shows `user_requested` with the reason and asks you. Accept, type a message yourself, and check the dump shows it sent with `sender: human`.
5. While the direct conversation is open, a message to the parent returns 409 `direct_conversation_open`.
6. Run with `--stream` and kill the network for 5 s. The agent reconnects with `Last-Event-ID`, with no missing or duplicated messages.

### M9: MCP

**Automated:** acceptance stage `mcp`, plus attacks A-33 to A-36.

**Manual:**

```bash
npm run chat -- --use-mcp
> What's on the ladder?
```

Expect:
- The answer comes from an MCP tool call, which shows in the transcript with no token in it.
- Running `curl -H "Authorization: Bearer <mcp token from debug vault>" https://tipping.ohare.id.au/api/fixtures` gives 401.

### M10: Two companies

**Automated:** acceptance stage `two-companies`, plus A-37.

**Manual:**

```bash
npm run chat
> Compare my tips this round with each team's recent form.
```

Expect:
- The agent discovers `stats.ohare.id.au` and starts a separate session, which you can see in both companies' logs.
- `npm run agent -- debug ids` shows different user IDs and DPoP thumbprints per company.

### M11: PACT comparison

**Manual review** of `docs/PACT-comparison.md`:
- Every row cites spec sections or code paths from both projects.
- The PACT commit tested is recorded.
- Blockers are listed as findings.
- The bank-fit section links back to briefing section 7.

### M12: WebMCP vs Poppy side by side

**Automated:** unit tests for the WebMCP tool handlers, plus A-41 (no tools registered on the login or consent pages).

**Manual:**
1. In Chrome, enable WebMCP: use the flag locally, or the origin trial token on `tipping.ohare.id.au`.
2. Sign in to the Tipping Co "My tips" page.
3. Ask the browser's agent to "tip the Storm this round".
4. Expect:
   - The agent lists `get-fixtures`, `get-my-tips` and `submit-tip`, then submits the tip with **no consent screen**.
   - The company log shows an ordinary cookie-session `POST`, with **no agent identity**.
5. Repeat with `npm run chat` (the Poppy agent). Expect:
   - A consent screen for `poppy:write`, unless already granted.
   - A company log line naming `client_id https://agent.ohare.id.au/agent.json`.
6. Open the login and consent pages in DevTools and run `document.modelContext` tool listing. Expect no tools, and the `Permissions-Policy: tools=()` response header.
7. Append both log excerpts and your observations to `poppy-vs-webmcp.md`, in the "Build experiment" section.

## Checkpoint evidence template

```markdown
### Checkpoint X: <date>
- gate-ci --full: <paste exit line>
- gate-verify: <paste summary>
- gate-mutation: <score, survivors>
- Manual checks: M? steps 1–n ✅ / ❌ (notes)
- SecurityReview items ticked: …
- Reviewer: Tim
```
