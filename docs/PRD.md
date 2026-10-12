# PRD: Poppy demonstration (minimal company and personal agent)

*Status: draft for review · 12 October 2026 · Owner: Tim O'Hare*
*Source: [briefing section 9](personal-agent-protocol-briefing.md#9-build-sketch-a-minimal-poppy-company-and-agent), Poppy spec draft 0.1*

## 1. Problem

The Poppy briefing explains the protocol on paper. Reading the spec doesn't show how discovery, agent identity, sessions, DPoP and sign-in actually fit together, or where they break. No public reference implementation exists yet. We need a small, working build that makes every check visible and can be attacked deliberately.

## 2. Goal

Build a minimal Poppy **company** ("Tipping Co", an NRL tipping service) and a **personal agent** that runs the core loop end to end:

> discover → start a signed-out session → call public APIs → hit `sign_in_required` → Direct Sign-In (PKCE) → act as the signed-in user → reuse the Account Token later → sign out

Every security check must be shown working by an automated test that fails when the check is removed.

## 3. Users

| User | Need |
|---|---|
| Tim (builder and learner) | See each protocol step and check happen, and be able to explain it to others. |
| Colleagues and stakeholders (bank, IAM audience) | A live demo plus documents showing what Poppy is and what it would take to adopt. |
| A future implementer | A readable reference to compare with off-the-shelf authorization servers and with PACT. |

## 4. Scope

### In scope (v1, briefing milestones 1–6)

| # | Capability | Spec |
|---|---|---|
| 1 | Company discovery files: `/.well-known/poppy.json`, `/.well-known/oauth-authorization-server` | 3 |
| 2 | Agent identity: `agent.json` (Client ID Metadata Document) and `jwks.json`, plus `/oauth/callback` | 4.1 |
| 3 | Signed-out Session via the JWT-bearer grant, returning a Session Token and `session_id` | 4.2 |
| 4 | DPoP-bound Session Tokens checked on every API request (`htm`, `htu`, `jti`, `iat`, `ath`, thumbprint) | 4.3 |
| 5 | Direct Sign-In: authorization code flow with PKCE (S256), `state`, `iss`, and consent per scope | 4.4–4.5 |
| 6 | Account Token: refresh grant with and without `session_id`, and revocation | 4.8 |
| 7 | Tipping Co API: `/api/fixtures`, `/api/ladder` (signed out); `/api/me/tips` GET (`poppy:read`) and POST (`poppy:write`); `/api/me/score` (custom `standings` scope) | 6 |
| 8 | Attack test suite (briefing milestone 5, plus the extras in [SecurityReview.md](SecurityReview.md)) | — |
| 9 | LLM in the loop: a `poppy_call(company, method, path, body)` tool. The model never sees tokens. | — |

### v1.1 scope (approved 12 Oct 2026, starts after v1 is accepted)

Tasks 13–23 in [TODO.md](TODO.md#v11-stretch-work).

| # | Capability | Spec |
|---|---|---|
| 10 | Always-on public hosting: AWS Lambda function URLs behind CloudFront, DynamoDB stores | — |
| 11 | Conversation API with a Claude-backed (LangGraph) company agent: long-poll, SSE, handoff to a human operator, direct conversations | 7 |
| 12 | MCP server with a resource-bound Bearer token | 4.3, RFC 8707 |
| 13 | A second company, "Footy Stats Co", to show one agent working with N companies | — |
| 14 | A timeboxed PACT evaluation, written up as `docs/PACT-comparison.md` | — |
| 15 | WebMCP build experiment: tools on a Tipping Co web page, run side by side with the Poppy agent (see [poppy-vs-webmcp.md](poppy-vs-webmcp.md)) | WebMCP draft |

### Out of scope

- Device Sign-In and Mediated Sign-In. Mediated sign-in is a non-starter for banks (briefing section 7).
- Web browsing and browser assertions (spec 5).
- Extensions (payments, push).
- Production hardening: persistent storage, multi-instance replay caches, rate limiting at scale, real user accounts.

## 5. Requirements

### Functional

| ID | Requirement |
|---|---|
| F1 | The agent rejects discovery if `organization.domain` ≠ the requested host, if the metadata `issuer` doesn't exactly match `auth.issuer`, or if `poppy_domains` doesn't include the domain. |
| F2 | The agent keeps a random per-issuer User ID that is never derived from personal data, and reuses it across runs. |
| F3 | The company verifies the client assertion and session assertion against the agent's `jwks_uri`. It checks `iss`, `aud` and `exp`, and rejects a reused `jti`. |
| F4 | The token response matches spec 4.2 (`access_token`, `token_type: DPoP`, `expires_in`, `scope`, `session_id`, `signed_in`). |
| F5 | Every API request needs `Authorization: DPoP <token>` plus a valid proof bound to the token's key thumbprint. Failures return 401 or 403 with a `WWW-Authenticate: DPoP` header. |
| F6 | Protected routes return 403 `sign_in_required` when signed out, and 403 `insufficient_scope` when a scope is missing. |
| F7 | The authorize endpoint matches `redirect_uri` exactly, requires PKCE S256, shows the agent's `client_name` and host with a checkbox per scope, and redirects with `code`, `state` and `iss`. |
| F8 | The code exchange requires the verifier, `session_id`, the client assertion and DPoP, and signs in *that* Session. Codes are single-use and short-lived. |
| F9 | The agent checks `state` and `iss` on the callback, and checks the granted `scope` after the exchange. |
| F10 | Refreshing with the Account Token works only for the same `client_id` and DPoP key. With `session_id` it signs in that Session; without it, it starts a new signed-in Session. |
| F11 | Revoking the Account Token signs the user out immediately. The next API call returns 403. |
| F12 | The LLM tool returns API results and errors to the model, never tokens, proofs, keys or `session_id`. |

#### v1.1 functional requirements

| ID | Requirement |
|---|---|
| F13 | Replay, code and message-ID checks hold across Lambda instances (conditional DynamoDB writes). |
| F14 | `htu` is computed from each service's configured `PUBLIC_BASE_URL`. CloudFront forwards `Authorization` and `DPoP` and doesn't cache API paths. |
| F15 | `poppy.json` lists a conversation protocol in `agent.protocols` with `"type": "poppy"` and its endpoint. |
| F16 | The conversation endpoints (start, messages, events, handoff, close) follow spec 7.2, with the message and event formats in briefing 9.8. |
| F17 | Each conversation belongs to the `client_id` and user ID that started it, or to the account once linked. Other callers get 404. |
| F18 | Message IDs are unique per user. A retry with the same content returns the original response, and different content returns 409 `message_id_conflict`. |
| F19 | Every successful POST and read includes `status` and `responder`. Every change to either emits a `state` event. |
| F20 | Events are read with opaque cursors, `has_more` and long-poll `wait` (capped at 25 s). |
| F21 | SSE streams use event IDs as the SSE `id` and support `Last-Event-ID` resume. The agent never acts on `text-delta`. |
| F22 | The company agent's tools act only for the conversation's account. It emits an `authorization` event when sign-in or a scope is needed. |
| F23 | Handoff sets `queued`, then `responder: human` when an operator joins. It returns to `idle` / `agent` if no operator joins in time. |
| F24 | Company messages carry `sender` (`agent`/`human`) and `role: company`. The agent sends `human` only for the user's own words. |
| F25 | Direct conversations follow spec 7.10 (`parent_conversation_id`, `user_requested`, `direct_opened`/`direct_closed`, 409 `direct_conversation_open`). |
| F26 | The operator console requires a password and CSRF tokens, and is rate limited. |
| F27 | The MCP server accepts only Bearer tokens issued for its exact `resource`. API routes reject MCP tokens, and `/mcp` rejects DPoP API tokens. |
| F28 | The agent loads MCP tools through LangGraph, with the token added by the transport, never by the model. |
| F29 | The agent keeps a separate random user ID and DPoP key per company. Tokens from one company are rejected at another. |
| F30 | The PACT comparison cites spec sections or code paths for every claim, and records the commit tested. |
| F31 | The Tipping Co "My tips" page registers `get-fixtures`, `get-my-tips` and `submit-tip` as WebMCP tools. The login and consent pages expose none (`Permissions-Policy: tools=()`). |

### Non-functional

| ID | Requirement |
|---|---|
| N1 | TypeScript (strict), Node 24 LTS (locally and on Lambda), `jose` for all JWT, JWK and DPoP work. |
| N2 | Runs fully locally with one command. From v1.1 (Task 14) it also runs publicly over HTTPS on AWS Lambda function URLs behind CloudFront. |
| N3 | Storage is in-memory maps behind an interface, so DynamoDB can replace it later. |
| N4 | Quality gates: `gate-ci` (lint, typecheck, tests, build) and `gate-verify` (boot and run the acceptance flow) must be green. `gate-mutation` runs on the crypto and auth module. |
| N5 | Logs never contain tokens, proofs, assertions, codes, verifiers or private keys. |
| N6 | Each protocol step is logged on both sides as a one-line, human-readable event, so the demo can be narrated. |

## 6. Success metrics

- All 6 v1 milestones pass the [HowToVerify.md](HowToVerify.md) steps.
- 100% of the attack tests fail closed with the expected error code.
- `gate-mutation` score is at least 80% on the auth and crypto module, with no surviving mutants in the DPoP or assertion checks.
- The demo can be run live in under 10 minutes from a cold start.

## 7. Architecture (summary)

```
packages/
  poppy-core/     shared: DPoP proof sign/verify, assertions, thumbprints, replay store, types
  company/        Tipping Co: well-known files, authorization server, API, middleware
  agent-host/     static agent.json and jwks.json, plus /oauth/callback (forwards code to the CLI)
  agent/          CLI and library: discover, session, sign-in, call, token vault, LangGraph (TS) tool
scripts/          key generation, local dev boot, acceptance flow
```

Key decisions (details in [TODO.md](TODO.md)):

1. **Hand-rolled authorization server** for v1, so every check is visible (briefing 9.1).
2. **HTTP framework: Hono.** It is small, typed and runs on both Node and Lambda.
3. **Dev-only localhost exception.** The spec requires an HTTPS `client_id`. A `POPPY_DEV_ALLOW_HTTP_LOCALHOST=1` flag lets the local acceptance run use `http://localhost`, and it is refused when `NODE_ENV=production`. See SecurityReview T-12.
4. **Automated sign-in in tests.** The acceptance script submits the login and consent forms over HTTP as a fixed test user. The live demo uses a real browser.

## 8. Risks and open questions

See the risks table in [TODO.md](TODO.md#risks-and-mitigations).

Decisions (12 October 2026; see the TODO.md decisions log):
1. **Hosting:** AWS Lambda function URLs behind CloudFront.
2. **LLM framework:** LangGraph (TS) with `@langchain/anthropic`, model `claude-sonnet-5-5`.
3. **Stretch goals:** all four are planned in detail as v1.1 (TODO.md Phases 6–10).

There are no open questions at present.
