# Implementation plan and task list: Poppy demonstration

*Draft for review · 12 October 2026 · Requirements: [PRD.md](PRD.md) · Verification: [HowToVerify.md](HowToVerify.md) · Threats: [SecurityReview.md](SecurityReview.md)*

## Overview

Build the minimal Poppy company (Tipping Co) and personal agent from briefing section 9, slice by slice, following the milestone order. Each slice is a complete path through agent, wire and company, with tests that fail if a check is removed. The riskiest piece (DPoP and assertion verification) comes first.

## Architecture decisions

| Decision | Rationale |
|---|---|
| npm workspaces monorepo: `poppy-core`, `company`, `agent-host`, `agent` | Shared crypto code is tested once. The packages map onto the briefing's three components. |
| Hono on Node 24 LTS, TypeScript strict, `jose` | Small and typed, and the same code runs on Lambda later (`nodejs24.x` runtime, confirmed in Task 14). Node 24 is what's installed locally. `jose` is what the briefing uses. |
| Hand-rolled authorization server | The point of v1 is to see every check (briefing 9.1). |
| In-memory stores behind interfaces (`SessionStore`, `ReplayStore`, `CodeStore`, `AccountTokenStore`) | Fast to build. DynamoDB with TTLs can be added later without touching the handlers. |
| LangGraph (TS) for the LLM loop, on `claude-sonnet-5-5` | Decided 12 Oct 2026. See the decisions log. |
| Opaque random Session Tokens held in a map | Revocation and the signed-in check apply on every request (briefing 9.6). The spec also allows JWTs, but opaque tokens are simpler to revoke. |
| Vitest 4 for unit and integration tests. Scripts (acceptance, dev boot) are TypeScript run directly by Node 24. | One runner. The acceptance script doubles as the `gate-verify` acceptance command. |
| A dev-only localhost HTTP exception, behind an env flag | The tests run without public hosting. The flag is refused in production (SecurityReview T-12). |

## Dependency graph

```
poppy-core (DPoP, assertions, thumbprint, replay store)
   │
   ├── company: well-known files ──┐
   ├── agent-host: agent.json/jwks │
   │                               ▼
   │                 agent: discover()  ── company: verifyAgent()
   │                               │
   │                               ▼
   │          token endpoint: JWT-bearer session grant ◄── agent: startSession()
   │                               │
   │                               ▼
   │          API middleware + public routes ◄── agent: call()
   │                               │
   │                               ▼
   │          authorize endpoint + code exchange ◄── agent: signIn() + callback
   │                               │
   │                               ▼
   │          protected routes, refresh, revoke ◄── agent: vault, resume, signOut
   │                               │
   │                               ▼
   │          attack suite ──► LLM tool ──► (stretch) conversations, MCP
```

## Task list

### Phase 0: Spikes (test risky assumptions before building on them)

A spike is a short, timeboxed experiment that answers one yes/no question. Each spike:
- runs in `spikes/Sn-<name>/`, outside the `packages/` build. The code is thrown away.
- ends with a short note in `docs/spikes/Sn-<name>.md`: the question, the answer, the evidence (commands and output), and any change to the plan.
- adds a line to the decisions log at the bottom of this file.

If a spike fails, take its fallback, update the affected tasks, and tell Tim before continuing. Spikes that need a person to do something are listed in [HUMAN-TODO.md](HUMAN-TODO.md).

**Order:**
1. Before Task 1: S4, then S5 and S3.
2. Before Task 12: S6.
3. Before Task 14: S9, S1 and S2, together as about one day of AWS work.
4. As later tasks start: S7, S8, S10 and S11.

#### Highest risk: could force a design change

| # | Spike | Assumption being tested | Timebox | Pass when | Fallback if it fails | Gates |
|---|---|---|---|---|---|---|
| **S1** | CloudFront → Lambda function URL with Poppy's auth headers | CloudFront can pass `Authorization: DPoP …`, the `DPoP` header and POST bodies through to a function URL unchanged. **Likely to fail as planned:** CloudFront's recommended way to restrict a function URL to CloudFront (Origin Access Control) signs requests with SigV4 using the `Authorization` header, and requires callers to send a SHA-256 hash of POST bodies. | ½ day | `curl` through CloudFront with a DPoP header and a form POST reaches the app with both intact | A public function URL with a CloudFront-added secret header checked by the app, **or** API Gateway HTTP API with a custom domain. Update Task 14 and `template.yaml`. | Task 14 |
| **S2** | Live streaming through CloudFront to Lambda | Hono's streaming adapter on a function URL, behind CloudFront, delivers SSE events as they're written, without buffering. A 25 s long-poll completes. | ½ day | Events arrive within about 1 s of being written, and a 25 s long-poll returns | Long-poll only (the spec allows it). If long-poll also fails, API Gateway WebSockets (outside the spec). | Tasks 14, 17 |
| **S3** | Browser callback reaching the CLI | After sign-in, a page on `https://agent.ohare.id.au/oauth/callback` can send the browser on to `http://127.0.0.1:<port>` where the CLI waits. Browsers are tightening rules on public pages sending users to local addresses. | 2 h | Works in current Chrome, Firefox and Safari without a warning | A loopback redirect URI registered directly (RFC 8252 style, if the spec allows it), or the CLI polls the agent host for the code, or manual paste | Task 8 |
| **S4** | Spec read-through against our flow | The flow in briefing 9.5 matches spec sections 4, 6 and 7 exactly: grant and parameter names, error codes, nonce handling, `aud` rules. | ½ day | A checklist (`docs/spikes/S4-spec-checklist.md`) maps every MUST in spec sections 4, 6 and 7 to a task or test | Fix the briefing, PRD and tasks before writing code | Task 1 |

#### Medium risk: library and tooling assumptions

| # | Spike | Assumption being tested | Timebox | Pass when | Fallback | Gates |
|---|---|---|---|---|---|---|
| **S5** | `jose` DPoP round trip | `jose` covers DPoP: `EmbeddedJWK` verification, `calculateJwkThumbprint`, rejecting private JWKs, pinning ES256. Our `htu` normalisation rules hold (trailing slash, port, case). | 2 h | The briefing's `dpopProof` and `verifyDpop` sketches work as written, with 6 negative tests | Small hand-written checks around `jose` | Task 2 |
| **S6** | LangGraph (TS) with Claude | `@langchain/langgraph` and `@langchain/anthropic` on `claude-sonnet-5-5` handle tool calls, a human-confirmation interrupt before writes, and keeping tokens out of model input. | ½ day | A two-tool graph runs with a confirmation interrupt before the write | Claude Agent SDK (TS) | Task 12 |
| **S7** | LangGraph in a Lambda worker | The DynamoDB Stream → worker Lambda delay, plus cold start and bundle size, gives an acceptable conversation delay. | ½ day | First reply in under ~5 s warm and under ~10 s cold, with a bundle under 50 MB zipped | The request Lambda invokes the worker directly (async), or use provisioned concurrency on demo days | Task 16 |
| **S8** | MCP tools in LangGraph with an injected Bearer token | `@langchain/mcp-adapters` over Streamable HTTP lets the transport add `Authorization`, so the model never sees it, and works with a stateless MCP server on Lambda. | ½ day | LangGraph lists and calls a tool on a stateless MCP server, with the token added by the transport | Use the MCP SDK client directly and wrap its tools by hand | Task 20 |

#### Lower risk: environment and external projects

| # | Spike | Assumption being tested | Timebox | Pass when | Fallback | Gates |
|---|---|---|---|---|---|---|
| **S9** | Domain and certificates | DNS records can be created for `ohare.id.au`, and an ACM certificate for `*.ohare.id.au` can be issued in us-east-1 (required by CloudFront). | 1 h | The certificate is issued and a test record resolves | Use the default CloudFront domains for the demo | Task 14 |
| **S10** | Is WebMCP usable? | Chrome 149 on Tim's OS exposes `document.modelContext`. Some agent actually consumes WebMCP tools (Chrome's built-in assistant, an inspector extension, or ChatGPT's browser). `Permissions-Policy: tools=()` is enforced. | 2 h | An agent lists and calls a test tool on a local page, and the policy blocks it on another page | Use a developer inspector extension, and record the result as "demonstrated with an inspector, not a real agent" | Task 23 |
| **S11** | Does PACT run? | PACT's reference implementation and conformance tests build and run as documented. | 1 h | Its sample flow and test suite run green | Make Task 22 a paper comparison, and record the blockers as findings | Task 22 |

### Checkpoint 0: Pre-build spikes
- [ ] S4, S5 and S3 are done, each with its note in `docs/spikes/`.
- [ ] Any plan changes are applied to the PRD, this file and the SecurityReview.
- [ ] Review with Tim before Task 1.

### Phase 1: Foundation

#### Task 1: Repo scaffold and harness binding
**Entry spike:** S4 must be done, with its note in `docs/spikes/` (see Phase 0).

**Description:** Create the npm workspaces repo with four packages, strict TS config, ESLint, Vitest and a `.claude/harness.json`, so the gates work from day one.

**Acceptance criteria:**
- [x] `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` exist and pass on a smoke test.
- [x] `package.json` sets `"engines": { "node": ">=24" }` and `"type": "module"`, and `.nvmrc` contains `24`. `tsconfig` sets `"erasableSyntaxOnly": true`, so Node 24 can run `.ts` scripts directly (S5 F1).
- [x] `.claude/harness.json` binds `lint`, `typecheck`, `build`, `boot`, `ready`, `readyMatch` and `acceptance` (acceptance can be a stub that exits 0 until Task 6).

**Verification:**
- [x] `node ~/dev/newdev/code-build-harness/harness/gates/ci.mjs --force --full` is green.
- [x] `node …/gates/resolve-cli.mjs --json` shows every key resolved.

**Dependencies:** S4 (Checkpoint 0)
**Files:** `package.json`, `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `packages/*/package.json`, `.claude/harness.json`
**Scope:** M

#### Task 2: `poppy-core` crypto and replay primitives
**Entry spike:** S5 must be done, with its note in `docs/spikes/` (see Phase 0).

**Description:** Implement and test `dpopProof`, `verifyDpop`, `clientAssertion`, `sessionAssertion`, `verifyAssertion`, `jwkThumbprint`, `sha256b64url` and a TTL `ReplayStore`. This is the riskiest code, so it goes first.

**Acceptance criteria:**
- [x] `verifyDpop` rejects each of these: wrong `typ` or `alg`, a private key in the `jwk` header, `htm` or `htu` mismatch (URL normalised: no query or fragment), `iat` older than 60 s or in the future beyond 5 s skew, a reused `jti`, and an `ath` mismatch.
- [x] Assertion verification rejects a wrong `iss`, an array or wrong `aud`, an expired `exp`, a reused `jti`, and a key not in the JWKS.
- [x] Every rejection test fails if its check is deleted (`gate-mutation` on `poppy-core`).
- [x] Starts from the S5 spike code and its 19 tests ([note](spikes/S5-jose-dpop.md)). The `jti` must be at least 16 characters. The replay store records a `jti` only after every other check passes. `htu` uses the shared `normalizeHtu()`.

**Verification:**
- [x] `npm test -w poppy-core` passes.
- [x] `node …/gates/mutation.mjs` scores at least 80% on `poppy-core`.

**Dependencies:** 1
**Files:** `packages/poppy-core/src/{dpop,assertions,replay,hash}.ts`, `packages/poppy-core/test/*.test.ts`
**Scope:** M

### Checkpoint A: Foundation
- [ ] `gate-ci --full` is green.
- [ ] The mutation score on `poppy-core` is at least 80%.
- [ ] Tim reviews the `poppy-core` API before anything builds on it.

### Phase 2: Discovery and signed-out session (milestones 1–2)

#### Task 3: Discovery, end to end
**Description:** The company serves `poppy.json` and the OAuth metadata (briefing 9.3). The agent host serves `agent.json` and `jwks.json` (9.4), with a key-generation script. The agent's `discover(host)` enforces F1.

**Acceptance criteria:**
- [x] Both well-known files and both agent files are served with the right content types and match the briefing examples.
- [x] `discover()` rejects a domain mismatch, an issuer mismatch and a missing `poppy_domains` entry (each with a test).
- [x] `discover()` follows redirects only to HTTPS URLs, ignores a leading `www.` when matching `organization.domain`, rejects an unsupported **major** `protocol_version`, and ignores unknown fields and extensions (S4 G11).
- [x] The OAuth metadata publishes `dpop_signing_alg_values_supported: ["ES256"]` (S5 F3).
- [x] `scripts/genkeys.ts` writes the private JWK outside the repo (or to a git-ignored path) and the public JWK with a `kid`.

**Verification:**
- [x] `npm test -w company -w agent-host -w agent` passes.
- [ ] Manual: `curl` each URL (see HowToVerify M1).

**Dependencies:** 2
**Files:** `packages/company/src/wellknown.ts`, `packages/agent-host/src/server.ts`, `packages/agent/src/discover.ts`, `scripts/genkeys.ts`, tests
**Scope:** M

#### Task 4: Session start (JWT-bearer grant), end to end
**Description:** The company's `verifyAgent` fetches and validates the client metadata, with SSRF guards. The token endpoint handles `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` with the client assertion, session assertion and DPoP proof, and returns the spec 4.2 response. The agent's `startSession()` creates or reuses the per-issuer User ID (F2).

**Acceptance criteria:**
- [x] The response body matches spec 4.2 exactly, with `signed_in: false` and `scope: ""`.
- [x] The session record stores `session_id`, `client_id`, user ID, account = none and the DPoP thumbprint.
- [x] Rejections: `client_id` not HTTPS (unless the dev flag is set), metadata `client_id` mismatch, `jwks_uri` on a different host, a reused assertion `jti`, a missing DPoP proof. Token-endpoint DPoP failures return **400** `invalid_dpop_proof` / `use_dpop_nonce` (S4 E3). The same-host check is deliberately stricter than the spec's same-domain rule (S4 notes).
- [x] Session **renewal**: the same grant with `session_id` returns a new signed-out token for that Session. It returns `invalid_session` if the Session ended or belongs to another `client_id` or User ID (S4 G1).
- [x] The agent retries once on `use_dpop_nonce` with the `DPoP-Nonce` value, and honours 429 `Retry-After` (S4 G5, G6).

**Verification:**
- [x] Integration test: agent → company in-process returns a Session Token.
- [x] `gate-ci` is green.

**Dependencies:** 3
**Files:** `packages/company/src/{verifyAgent,token,stores}.ts`, `packages/agent/src/{session,userIds}.ts`, tests
**Scope:** M

#### Task 5: DPoP-protected public API, end to end
**Description:** API middleware (briefing 9.6 steps 1–4), plus `/api/fixtures` and `/api/ladder` with seed NRL data. The agent's `call(method, path, body)` signs a fresh proof per request and handles a `DPoP-Nonce` retry if one is sent.

**Acceptance criteria:**
- [x] With a valid token and proof, both routes return 200 with fixture data.
- [x] Failures return 401 `invalid_token` or `invalid_dpop_proof` with `WWW-Authenticate: DPoP` (F5).
- [x] An OpenAPI document at `/openapi.json` describes all routes.
- [x] A token in the URL (`?access_token=`) is never accepted (A-42). `call()` never puts tokens in URLs, and handles `use_dpop_nonce` and 429 `Retry-After` (S4 G5–G7).

**Verification:**
- [x] Integration tests pass.
- [x] Manual: `npm run agent -- fixtures` prints fixtures. (Locally it's `npm run agent:local -- fixtures`, which sets the dev flag; checked against `npm run dev:local` on 12 Oct.)

**Dependencies:** 4
**Files:** `packages/company/src/{middleware,api/public,openapi}.ts`, `packages/agent/src/call.ts`, `packages/agent/src/cli.ts`
**Scope:** M

#### Task 6: Local boot and acceptance script (milestones 1–2)
**Description:** `npm run dev:local` boots the company (port 8787) and the agent host (port 8788) with the dev flag set. `scripts/acceptance.ts` runs discover → session → fixtures and exits non-zero on any failure. Wire this into `harness.json`.

**Acceptance criteria:**
- [ ] `gate-verify` boots both services, waits for readiness and runs the acceptance script to green.
- [ ] Each protocol step prints one narrated log line (N6), and no secrets appear in the output (N5).
- [ ] Any login-form automation lives in `scripts/` (the harness plays the user), never in `packages/agent`. A test greps `packages/agent/src` for form-filling code (spec 4.4, S4 E4).

**Verification:**
- [ ] `node …/gates/verify.mjs` is green.

**Dependencies:** 5
**Files:** `scripts/{dev-local,acceptance}.ts`, `.claude/harness.json`
**Scope:** S

### Checkpoint B: Milestones 1–2
- [ ] `gate-ci --full` and `gate-verify` are green.
- [ ] Public HTTPS hosting comes later, in Task 14 (Lambda). Until then the M1 checks run against localhost.
- [ ] Review with Tim before starting sign-in.

### Phase 3: Direct Sign-In (milestone 3)

#### Task 7: Authorize endpoint with login and consent
**Description:** `GET /oauth/authorize` validates `client_id` (via `verifyAgent`), checks that `redirect_uri` exactly matches the metadata, requires `code_challenge_method=S256`, and shows a login form. Next it shows a consent page with `client_name`, the `client_id` host and a checkbox per scope. It issues a single-use code (60 s) bound to the client, redirect URI, challenge, granted scopes and user, then redirects with `code`, `state` and `iss`.

**Acceptance criteria:**
- [ ] Mismatched `redirect_uri` and missing or `plain` PKCE are refused, *without* redirecting to the bad URI.
- [ ] The forms carry CSRF tokens. Pages send `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`.
- [ ] Unticking a scope leaves it out of the issued code.
- [ ] A missing, unknown or unavailable `scope` gives `invalid_scope` (A-44). Declining redirects with `error=access_denied` plus `iss` (S4 G3, G4).

**Verification:**
- [ ] Integration tests drive the forms over HTTP.
- [ ] Manual: the consent page renders in a browser.

**Dependencies:** 4
**Files:** `packages/company/src/{authorize,views,users,codes}.ts`, tests
**Scope:** M

#### Task 8: Code exchange and agent sign-in, end to end
**Entry spike:** S3 must be done, with its note in `docs/spikes/` (see Phase 0).

**Description:** The token endpoint handles `authorization_code` with the verifier, `session_id`, client assertion and DPoP proof. It signs in that Session and returns an Account Token plus the signed-in token. The agent builds the authorize URL (PKCE and `state`), opens the browser, and receives the code via the agent-host callback (handed to the CLI over a local loopback or a short poll). It checks `state` and `iss` (F9) and stores the Account Token in the vault.

**Acceptance criteria:**
- [ ] A code works once only, only with the right verifier, client, redirect URI and `session_id` (a Session of the same `client_id`). The new Session Token is bound to the key in the exchange request's proof (spec 4.3, S4 E1).
- [ ] The agent rejects a callback with a wrong `state` or `iss`, handles `error=access_denied`, and warns when the granted `scope` is narrower than requested.
- [ ] The Account Token **and the per-company DPoP private keys** are stored encrypted at rest (OS keychain, or a file encrypted with a local key) and never printed (S5 F2).

**Verification:**
- [ ] The acceptance script extends to: sign-in using form automation in `scripts/`, playing the test user (never the agent library; S4 E4).
- [ ] `gate-verify` is green.

**Dependencies:** 7, 5
**Files:** `packages/company/src/token.ts`, `packages/agent/src/{signin,vault}.ts`, `packages/agent-host/src/callback.ts`, `scripts/acceptance.ts`
**Scope:** M

#### Task 9: Protected tipping routes, end to end
**Description:** Add `GET /api/me/tips` (`poppy:read`), `POST /api/me/tips` (`poppy:write`) and `GET /api/me/score` (custom `standings` scope). The agent reacts to 403 `sign_in_required` by starting sign-in, and to `insufficient_scope` by reporting the missing scope.

**Acceptance criteria:**
- [ ] A signed-out request gets 403 `sign_in_required`. A signed-in request without the scope gets 403 `insufficient_scope` with `scope=` in `WWW-Authenticate`.
- [ ] A tip is validated (a known round and fixture, a team in that fixture) and persisted per account.

**Verification:**
- [ ] The acceptance script extends to: GET 403 → sign-in → POST tip → GET shows it.
- [ ] `gate-verify` is green.

**Dependencies:** 8
**Files:** `packages/company/src/api/me.ts`, `packages/agent/src/cli.ts`, tests
**Scope:** S

### Checkpoint C: Milestone 3
- [ ] HowToVerify M3 is complete, including a manual browser sign-in.
- [ ] Review with Tim.

### Phase 4: Account lifecycle and attacks (milestones 4–5)

#### Task 10: Refresh and revocation, end to end
**Description:** The `refresh_token` grant works with and without `session_id` (F10). `POST /oauth/revoke` revokes the Account Token and signs out its sessions. The middleware re-checks the signed-in state on every request (F11). The agent gets `resume` and `signout` commands.

**Acceptance criteria:**
- [ ] Refresh from a different `client_id` fails with `invalid_grant`. Refresh with a **new DPoP key** succeeds, and the new token is bound to that key (spec 4.3, 4.8; S4 E1).
- [ ] A Session signed in to another account gives `account_mismatch` (A-43). `scope` can narrow but not widen. If the Company rotates the `refresh_token`, the agent's vault replaces it (S4 G2, G8, G9).
- [ ] Revocation needs the client assertion. Revoking from another `client_id` fails and leaves the token valid (A-46, S4 G12).
- [ ] After revocation, the next `/api/me/tips` call returns 403, and refresh fails.

**Verification:**
- [ ] The acceptance script extends to milestone 4 (kill → resume → signout → 403).
- [ ] `gate-verify` is green.

**Dependencies:** 9
**Files:** `packages/company/src/{token,revoke,middleware}.ts`, `packages/agent/src/{resume,signout}.ts`
**Scope:** M

#### Task 11: Attack suite
**Description:** A dedicated test file plus an acceptance stage for every attack in SecurityReview section 5 (the 5 from the briefing, plus extras). Each attack asserts the exact status and error code.

**Acceptance criteria:**
- [ ] Every attack row in SecurityReview section 5 has a test, and every one fails closed.
- [ ] `npm run attacks` prints a pass/fail table and exits non-zero on any unexpected success.

**Verification:**
- [ ] `npm run attacks` is green, and `gate-verify` runs it as part of the acceptance stage.
- [ ] `gate-mutation` on `company/src/{middleware,token,authorize}.ts` is at least 80%.

**Dependencies:** 10
**Files:** `packages/company/test/attacks.test.ts`, `scripts/attacks.ts`
**Scope:** M

### Checkpoint D: Milestones 4–5
- [ ] `gate-ci --full`, `gate-verify` and `gate-mutation` are green.
- [ ] Every item in SecurityReview section 7 is ticked, or accepted with a reason.
- [ ] Review with Tim. This is the **v1 security sign-off**.

### Phase 5: LLM in the loop (milestone 6)

#### Task 12: `poppy_call` tool and demo agent
**Entry spike:** S6 must be done, with its note in `docs/spikes/` (see Phase 0).

**Description:** Wrap the agent library as a tool `poppy_call(company, method, path, body)` that handles discovery, sessions, sign-in prompts and retries. Build a small LangGraph (TS) chat agent with `@langchain/anthropic` on `claude-sonnet-5-5` that can answer "what are this round's fixtures?" and "tip the Storm this round".

**Acceptance criteria:**
- [ ] The tool's output contains only the API status and body, or an error code. A test checks that no token, proof, key, code or `session_id` appears in any tool output or model message (F12).
- [ ] Sign-in needs the user's action in the browser. The model can't complete it.
- [ ] Prompt-injection test: a fixture name containing instructions doesn't cause a write the user didn't request (SecurityReview T-15).

**Verification:**
- [ ] Unit tests use a stubbed model. A recorded live run is checked manually.
- [ ] `gate-ci` is green.

**Dependencies:** 10
**Files:** `packages/agent/src/{tool,chat}.ts`, tests
**Scope:** M

### Checkpoint E: v1 complete
- [ ] All six milestones pass HowToVerify.
- [ ] The PRD success metrics are met.
- [ ] The live HTTPS demo has been rehearsed.

## v1.1: Stretch work

*Approved 12 October 2026. Starts only after Checkpoint E. Decisions: all four stretch items, LangGraph (TS) with `@langchain/anthropic` on `claude-sonnet-5-5`, and AWS Lambda function URLs for public hosting.*

### v1.1 architecture decisions

| Decision | Rationale |
|---|---|
| AWS SAM (`template.yaml`), one Lambda per service (company, agent host, company-agent worker, operator console, MCP), each with a function URL | The harness autodetects SAM. `gate-verify` can run against DynamoDB Local (`mockAws: dynamodb-local`). |
| CloudFront in front of the function URLs, for `tipping.ohare.id.au`, `agent.ohare.id.au` and `stats.ohare.id.au` | Function URLs can't take custom domains. CloudFront must forward the `Authorization` and `DPoP` headers and must not cache API paths. |
| DynamoDB single table with TTL, behind the v1 store interfaces, plus a new `ConversationStore` | In-memory maps don't survive across Lambda instances. `jti`, code and message-ID checks use conditional `PutItem` (`attribute_not_exists`), so they hold across instances. |
| Function URL invoke mode `RESPONSE_STREAM` for conversation `events` | Long-poll (`wait` ≤ 25 s) and SSE need streaming. Streams close at about 60 s and the agent resumes with `Last-Event-ID`. |
| The company agent runs in a **worker Lambda** triggered by a DynamoDB Stream on new user messages | A POST returns 201/202 immediately (spec 7.3). No work is lost when the request Lambda freezes. |
| LangGraph for both the personal agent (Task 12) and the company agent | One framework for both sides. |
| Company-agent tools call internal services scoped to the conversation's account | No tokens enter the model's context. The account comes from the conversation record, never from the model. |
| `text-delta` streaming only in local mode | The spec says MAY. Cloud deltas would need extra storage and fan-out. |
| `company` package becomes config-driven (`CompanyConfig`) | The second company is config plus one route module, not a fork. |
| PACT is cloned to `~/dev/newdev/pact-eval/` and treated as untrusted | Downloaded code stays outside this repo. The output is a comparison doc. |

### Phase 6: Cloud foundation

#### Task 13: DynamoDB stores
**Description:** Implement every v1 store interface on DynamoDB with TTLs and conditional writes. Keep the in-memory stores for unit tests.

**Acceptance criteria:**
- [ ] The full v1 test suite passes against both the in-memory stores and DynamoDB Local.
- [ ] Two concurrent requests with the same `jti` (or the same code) produce exactly one success (A-40).

**Verification:**
- [ ] `harness.json` gains `"mockAws": "dynamodb-local"`, and `gate-verify` is green.
- [ ] `gate-mutation` on `company/src/stores/dynamo.ts` is at least 80%.

**Dependencies:** Checkpoint E
**Files:** `packages/company/src/stores/dynamo.ts`, `packages/company/test/stores.contract.test.ts`, `.claude/harness.json`
**Scope:** M

#### Task 14: SAM deploy and cloud smoke test
**Entry spike:** S9, S1 and S2 must be done, with its note in `docs/spikes/` (see Phase 0).

**Description:** Deploy the company and agent host as Lambdas with function URLs behind CloudFront. Use least-privilege IAM per function, put the agent signing key in Secrets Manager, and set `PUBLIC_BASE_URL` per service so `htu` matches the public URL.

**Acceptance criteria:**
- [ ] `npm run smoke:cloud` runs the v1 acceptance flow (M1–M4) against the deployed URLs.
- [ ] `POPPY_DEV_ALLOW_HTTP_LOCALHOST` is absent from every deployed function, and CloudFront forwards `Authorization` and `DPoP` (A-39).
- [ ] An IAM policy test shows each function can reach only its own table actions and secrets (A-38).

**Verification:**
- [ ] `sam validate --lint`, then `sam deploy`, then `npm run smoke:cloud` exits 0.
- [ ] `npm run attacks -- --base https://tipping.ohare.id.au` is green.

**Dependencies:** 13
**Files:** `template.yaml`, `packages/*/src/lambda.ts`, `scripts/smoke-cloud.ts`, `samconfig.toml`
**Scope:** M

### Checkpoint F: v1 on Lambda
- [ ] The cloud smoke test and the attack suite pass against the deployment.
- [ ] Spikes S1, S2 and S9 are done, and their fallbacks are applied if needed.
- [ ] Review with Tim.

### Phase 7: Conversation API (spec section 7, briefing 9.8)

#### Task 15: Conversations with a scripted company agent
**Description:** Add the conversation endpoints:
- `POST {endpoint}`
- `/{id}/messages`
- `GET /{id}/events` (JSON and long-poll)
- `/{id}/close`

Add the `agent.protocols` entry in `poppy.json`. A worker Lambda replies with a scripted echo. The agent gets `npm run agent -- chat-company`.

**Acceptance criteria:**
- [ ] The message and event JSON matches briefing 9.8 field for field (a schema test built from the spec examples). Every response includes `status` and `responder`.
- [ ] A retried first message returns the same conversation, and a reused ID with different content returns 409 `message_id_conflict`.
- [ ] Ownership is enforced (`client_id` + user ID, or the account once linked). Another user's conversation returns 404 (A-25). All 7.13 error codes are covered.

**Verification:**
- [ ] Acceptance stage "conversation" passes in `gate-verify`.

**Dependencies:** 14
**Files:** `packages/poppy-core/src/conversation.ts`, `packages/company/src/conversations/{routes,store,worker}.ts`, `packages/agent/src/conversation.ts`
**Scope:** M

#### Task 16: Claude-backed company agent
**Entry spike:** S7 must be done, with its note in `docs/spikes/` (see Phase 0).

**Description:** Replace the echo with a LangGraph company agent. Its tools are `get_fixtures`, `get_ladder`, `get_my_tips` and `submit_tip`, all scoped to the conversation's account. It emits an `authorization` event when it needs sign-in or a scope, and it uses `context` (locale, time zone, `user_available`).

**Acceptance criteria:**
- [ ] A tip submitted through the conversation is identical to one submitted through `POST /api/me/tips`.
- [ ] No token or `session_id` appears in model input (a test inspects every model call).
- [ ] An injection in a fixture name or user message doesn't cause an unrequested write (A-26).
- [ ] No Account Token or Session Token appears in any conversation message (spec 4.8, S4 G10). A person at the company is held to the same scopes as the agent, and after account use a not-signed-in token gets `sign_in_required` (spec 7.11).

**Verification:**
- [ ] Tests with a stubbed model. HowToVerify M7 is the manual live run.

**Dependencies:** 15
**Files:** `packages/company/src/conversations/companyAgent.ts`, tests
**Scope:** M

#### Task 17: SSE streaming
**Entry spike:** S2 (done before Task 14) must be done, with its note in `docs/spikes/` (see Phase 0).

**Description:** `Accept: text/event-stream` on `events`, with event IDs as the SSE `id`, `Last-Event-ID` resume, and `text-delta` in local mode only. The agent's reader reconnects and skips duplicate event IDs.

**Acceptance criteria:**
- [ ] When the stream is killed mid-conversation, the agent resumes with no lost or duplicated events.
- [ ] The agent never acts on `text-delta` text. `wait` is capped at 25 s, streams at 60 s, and concurrent streams per session are limited (A-29).

**Verification:**
- [ ] An integration test with forced disconnects. A manual check through CloudFront.

**Dependencies:** 15
**Files:** `packages/company/src/conversations/sse.ts`, `packages/agent/src/eventReader.ts`
**Scope:** S

#### Task 18: Human handoff and operator console
**Description:** `POST /{id}/handoff` sets the status to `queued`. A small operator console (a separate Lambda, with a password from Secrets Manager plus a CSRF token) lets an operator:
- list queued conversations
- join (`responder: human`)
- reply (`sender: human`)
- hand the conversation back to the agent

With no operator, the conversation times out to `idle` with `responder: agent`.

**Acceptance criteria:**
- [ ] A `state` event is emitted on every `status` or `responder` change, and each company message carries the correct `sender`.
- [ ] The console rejects a missing CSRF token or a bad password, and is rate limited (A-27, A-28).

**Verification:**
- [ ] Acceptance stage "handoff" (operator scripted over HTTP). HowToVerify M8 is the browser check.

**Dependencies:** 16
**Files:** `packages/operator-console/src/*`, `packages/company/src/conversations/handoff.ts`, `template.yaml`
**Scope:** M

#### Task 19: Direct conversations
**Description:**
- The company emits `user_requested` with a `reason`.
- The agent asks the user, then opens a Direct Conversation with `parent_conversation_id`. The user's own words are sent with `sender: "human"`.
- The parent records `direct_opened` and `direct_closed`, and returns 409 `direct_conversation_open` while the direct conversation is open.

**Acceptance criteria:**
- [ ] Spec 7.10 behaviour, end to end.
- [ ] A unit test proves the agent labels a summary or paraphrase of the user's words as `agent`, never `human`.

**Verification:**
- [ ] Acceptance stage "direct".

**Dependencies:** 18
**Files:** `packages/company/src/conversations/direct.ts`, `packages/agent/src/direct.ts`
**Scope:** S

### Checkpoint G: Conversations
- [ ] HowToVerify M7–M8 pass in the cloud.
- [ ] SecurityReview T-21 to T-28 are ticked.
- [ ] Review with Tim.

### Phase 8: MCP server

#### Task 20: MCP server with a resource-bound Bearer token
**Entry spike:** S8 must be done, with its note in `docs/spikes/` (see Phase 0).

**Description:**
- **Company:** a Streamable HTTP MCP server (`@modelcontextprotocol/sdk`, stateless) at `https://tipping.ohare.id.au/mcp`, with the same tools as the API, listed in `poppy.json` with `type: mcp`.
- **Token endpoint:** a request with `resource=<mcp url>`, `session_id` and no DPoP proof returns `token_type: Bearer`, an audience-restricted token.
- **Agent:** LangGraph loads the tools via `@langchain/mcp-adapters`, and the transport (not the model) adds the token. Start with a version-pinning spike.

**Acceptance criteria:**
- [ ] The MCP token is rejected at `/api/*`, and DPoP API tokens are rejected at `/mcp`.
- [ ] A missing or wrong `resource` gives 400 `invalid_target`, and revocation also ends MCP access (A-33 to A-36).
- [ ] The MCP server publishes protected resource metadata (RFC 9728) whose `authorization_servers` includes `auth.issuer`, and speaks MCP 2025-06-18 or later (spec 6, S4 G13).

**Verification:**
- [ ] Acceptance stage "mcp". HowToVerify M9.

**Dependencies:** 14
**Files:** `packages/company/src/mcp/{server,auth}.ts`, `packages/agent/src/mcp.ts`, `template.yaml`
**Scope:** M

### Checkpoint H: MCP
- [ ] HowToVerify M9 passes, and `gate-mutation` on `company/src/mcp/auth.ts` is at least 80%.

### Phase 9: Second company

#### Task 21: Config-driven company plus "Footy Stats Co"
**Description:** Refactor `company` to take a `CompanyConfig`, then deploy `stats.ohare.id.au`, which has:
- public player stats
- a custom `favourites` scope
- a company agent, and no write API

The agent discovers both companies and keeps a separate random user ID and DPoP key for each. The demo prompt is "compare my tips with this week's form".

**Acceptance criteria:**
- [ ] The Tipping Co v1 tests pass unchanged after the refactor.
- [ ] The user IDs and DPoP thumbprints differ between companies (unlinkability test).
- [ ] A token from one company is rejected at the other (A-37).

**Verification:**
- [ ] Acceptance stage "two-companies", plus `npm run smoke:cloud` for both. HowToVerify M10.

**Dependencies:** 14 (and 15–16 for the company agent)
**Files:** `packages/company/src/config.ts`, `companies/{tipping,stats}.ts`, `template.yaml`
**Scope:** M

### Checkpoint I: Two companies
- [ ] HowToVerify M10 passes in the cloud.

### Phase 10: PACT comparison

#### Task 22: PACT evaluation write-up (timeboxed to one day)
**Entry spike:** S11 must be done, with its note in `docs/spikes/` (see Phase 0).

**Description:** Clone `openpactprotocol/openpactprotocol` into `~/dev/newdev/pact-eval/` and run its reference implementation and conformance tests. Model the same tipping scenario, then write `docs/PACT-comparison.md`. It should cover:
- discovery
- agent identity
- token binding
- consent granularity
- conversations (A2A vs Poppy section 7)
- conformance tooling
- fit for banks

**Acceptance criteria:**
- [ ] Every comparison row cites spec sections or code paths from both projects.
- [ ] The doc records the PACT commit tested, and lists any blockers as findings.

**Verification:**
- [ ] Manual review by Tim (HowToVerify M11).

**Dependencies:** Checkpoint E (independent of Tasks 13–21)
**Files:** `docs/PACT-comparison.md`
**Scope:** S

### Phase 11: WebMCP comparison experiment

See [poppy-vs-webmcp.md](poppy-vs-webmcp.md), "Build experiment".

#### Task 23: WebMCP tools on Tipping Co pages
**Entry spike:** S10 must be done, with its note in `docs/spikes/` (see Phase 0).

**Description:** Add a minimal signed-in web page to Tipping Co ("My tips"), using the same login and a first-party cookie session. Register WebMCP tools on it with `document.modelContext.registerTool()`:
- `get-fixtures`
- `get-my-tips`
- `submit-tip`

The tools reuse the page's existing fetch code (roughly 30 lines). Add `Permissions-Policy: tools=()` to the login and consent pages, so an in-browser agent can't drive them. Run the same "tip the Storm" task with a WebMCP agent in Chrome and with the Poppy agent, and record the contrast in the comparison doc.

**Acceptance criteria:**
- [ ] In Chrome (flag locally, origin trial token on `tipping.ohare.id.au`), an in-browser agent lists the three tools and submits a tip. The company log records it as an ordinary cookie-session request, with no agent identity.
- [ ] The same task through Poppy needs a consent grant of `poppy:write`, and the log names the agent's `client_id`.
- [ ] The login and consent pages expose no WebMCP tools, so `document.modelContext` registration is blocked by `Permissions-Policy` (A-41).

**Verification:**
- [ ] A unit test for the tool handlers (schema plus the reused fetch). HowToVerify M12 is the manual side-by-side run, and its results are appended to `poppy-vs-webmcp.md`.

**Dependencies:** Task 9 (v1). Task 14 for the cloud origin trial.
**Files:** `packages/company/src/web/{myTips,webmcp}.ts`, `packages/company/src/views/*`, `docs/poppy-vs-webmcp.md`
**Scope:** S

### Checkpoint K: WebMCP comparison
- [ ] HowToVerify M12 passes, and the side-by-side results are recorded in `poppy-vs-webmcp.md`.

### Checkpoint J: v1.1 complete
- [ ] `gate-ci --full`, `gate-verify` and `gate-mutation` are green.
- [ ] `npm run attacks` covers A-01 to A-46.
- [ ] The cloud smoke test passes for both companies, and PR-FAQ.md is updated.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Spec draft 0.1 changes under us | Med | Pin to the draft dated 9 Oct 2026. Keep protocol constants and the conversation schema in `poppy-core`. Record differences in the briefing. |
| `htu` normalisation mismatches (CloudFront, trailing slash) | High | Compute `htu` from `PUBLIC_BASE_URL`, not request headers. Spikes S5 and S1. Test through CloudFront at Checkpoint F. |
| CloudFront's function-URL protection (OAC) clashes with Poppy's `Authorization` header and POST bodies | High | Spike S1 before Task 14. The fallback is a public function URL plus a CloudFront secret header, or API Gateway HTTP API. |
| Clock skew between machines breaks `iat` checks | Med | Allow ±5 s skew, support `DPoP-Nonce`, and log the skew on rejection. |
| Browser callback to a CLI is awkward | Med | The agent-host callback page redirects the browser to a loopback listener started by the CLI (one-time token in `state`). Spike S3. Fall back to manual paste. |
| Hand-rolled AS contains a security bug | High | Attack suite, mutation testing, and SecurityReview sign-off at Checkpoint D. Never deploy beyond the demo. |
| LLM leaks or misuses credentials | High | Tokens live only in the vault and tool internals. Tested by F12, T-15 and A-26. |
| Lambda streaming quirks (CloudFront buffering, 60 s cap) | Med | Spike S2 before Task 14. Fall back to long-poll, which the spec permits. |
| LangGraph TS / `@langchain/mcp-adapters` version drift | Med | Pin exact versions. Spikes S6 and S8. |
| Cost or abuse of the public Claude-backed agent | Med | Per-session rate limits, an AWS budget alarm, and an operator kill switch. |
| PACT repo immaturity | Low | Spike S11, timebox to one day, and record blockers as findings. |
| Spec misread in the briefing | Med | Spike S4 maps every MUST to a task or test before Task 1. |

## Parallelisation

- After Task 2: Task 3's company side and agent-host side can run in parallel.
- Task 7 (authorize UI) can start alongside Task 5 once Task 4 is done.
- After Task 14: Tasks 15, 20 and 21 (refactor part) can run in parallel. Task 22 (PACT) and Task 23 (WebMCP, locally) can run any time after Checkpoint E.

## Decisions log

| Date | Decision |
|---|---|
| 12 Oct 2026 | Public hosting: AWS Lambda function URLs behind CloudFront (not a Cloudflare tunnel). |
| 12 Oct 2026 | LLM framework: LangGraph (TS) with `@langchain/anthropic`, model `claude-sonnet-5-5`. Google ADK was considered, but its TypeScript version documents Gemini only. |
| 12 Oct 2026 | Stretch scope: Conversation API, MCP server, second company and PACT comparison, all planned in detail above. |
| 12 Oct 2026 | Added Task 23: the WebMCP build experiment from [poppy-vs-webmcp.md](poppy-vs-webmcp.md). |
| 12 Oct 2026 | Added Phase 0 spikes S1–S11 and per-task entry spikes. Human actions are tracked in [HUMAN-TODO.md](HUMAN-TODO.md). |
| 12 Oct 2026 | **Spike S5 done** ([note](spikes/S5-jose-dpop.md)). `jose` 6.2.12 covers DPoP, with 19 tests passing and every check proven by deletion. Applied: ESM plus `erasableSyntaxOnly` (Task 1), replay-last order and `jti` length (Task 2), `dpop_signing_alg_values_supported` (Task 3), DPoP keys in the vault (Task 8). |
| 12 Oct 2026 | **Spike S4 done** ([note](spikes/S4-spec-checklist.md)). Fixed 4 errors (the Account Token isn't bound to the DPoP key; `invalid_session` for a foreign `session_id`; token-endpoint DPoP errors are 400; sign-in automation stays in the harness) and closed 13 gaps in Tasks 3–10, 16 and 20. Added attacks A-42 to A-46. |
| 12 Oct 2026 | **Tasks 1 and 2 done** (overnight run, Checkpoint 0/A reviews deferred to Tim). Pinned **Vitest 4.1.11, not 5**: Stryker 10.0.0's Vitest runner never sees mutants killed under Vitest 5 (every DPoP mutant "survived", although the tests fail when the mutant is switched on by hand). TypeScript is pinned at 6.0.3 because `typescript-eslint` doesn't support TS 7 yet. Scripts run with plain `node` (S5 F1), so `tsx` isn't needed. `poppy-core` mutation score: 96.2%. |
| 12 Oct 2026 | **Tasks 3 and 4 done.** Pulled the agent vault forward from Task 8, because Task 4 already needs per-issuer User IDs and DPoP keys to persist: `FileVault` is AES-256-GCM with a separate 0600 key file (the HUMAN-TODO fallback; an OS keychain can replace it). The token endpoint checks the DPoP proof **before** client authentication, so a nonce retry doesn't burn the agent's assertion `jti`s. Shared in-process wiring lives in `test-support/testbed.ts`. |
