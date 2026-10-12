# Spike S4: spec read-through checklist

*Done 12 October 2026 · Spec: Poppy draft 0.1, "Updated Oct 9, 2026" (https://personalagentprotocol.org/docs/spec), re-fetched today and identical to the copy read earlier (SHA-256 of the extracted text starts `1971ed19449dd117`). 59 occurrences of MUST in the spec.*

## Question

Does the flow in briefing section 9 and the plan (PRD, TODO, SecurityReview) match spec sections 3, 4, 6 and 7 exactly?

## Answer

**Mostly, but not exactly.** The core flow is right. The read-through found **4 errors** in the plan and **13 gaps** where a spec requirement had no task or test. All of them are fixed in the plan docs in the same commit as this note. None of them changes the architecture.

### Errors (the plan contradicted the spec)

| # | What the plan said | What the spec says | Fix applied |
|---|---|---|---|
| E1 | The Account Token refresh works "only for the same `client_id` **and DPoP key**" (PRD F10, Task 10, A-20) | The Account Token is bound to the `client_id` via the client assertion (4.8). DPoP keys are per user per company, and a Personal Agent **MAY use a new key for each Session** (4.3). Each new Session Token is bound to the key in *that* request's proof. | F10, Tasks 8 and 10, and A-20 now bind refresh and code exchange to the `client_id` only. A new test checks that refresh with a new DPoP key **succeeds**, and that the new token is bound to the new key. |
| E2 | Using another agent's `session_id` returns `invalid_grant` (A-04) | Returns **`invalid_session`** (400) when the Session belongs to a different Personal Agent or User (4.2, 4.8) | A-04 updated |
| E3 | DPoP failures return **401** everywhere | At the **token endpoint**, `invalid_dpop_proof` and `use_dpop_nonce` are **400** (4.2 error table). At APIs they're **401**, with `WWW-Authenticate: DPoP` (RFC 9449). | SecurityReview now states which status applies at which endpoint. New attack A-45 covers a bad proof at the token endpoint. |
| E4 | The acceptance script signs in "as the test user" through form automation, without saying who does it | 4.4: a Personal Agent **MUST** use Direct Sign-In only when the User signs in themselves | The form automation lives in the **test harness**, which plays the user, never in the agent library. A test checks that `packages/agent` contains no login-form code. Noted in Tasks 6 and 8. |

### Gaps (a spec requirement had no task or test)

| # | Requirement | Spec | Added to |
|---|---|---|---|
| G1 | Session **renewal**: the JWT-bearer grant again with `session_id`. `invalid_session` if the Session ended or belongs to someone else. | 4.2 | Task 4 |
| G2 | `account_mismatch` when a Session signed in to one account is used with another account's token | 4.4, 4.8 | Task 10, A-43 |
| G3 | Each sign-in request MUST include `scope`. A missing, unknown or unavailable scope returns `invalid_scope`. The Company MUST NOT grant beyond what was requested and allowed for the type. | 4.4 | Task 7, A-44 |
| G4 | The user declining returns `error=access_denied` plus `iss` | 4.5 | Tasks 7 and 8 |
| G5 | The agent MUST support DPoP nonces (`use_dpop_nonce` with a `DPoP-Nonce` header), **including at the token endpoint** | 4.3 | Tasks 4 and 5 |
| G6 | 429 with `Retry-After`, which the agent MUST honour. The token endpoint has `rate_limited`. | 4.2, 4.3 | Tasks 4 and 5 |
| G7 | Companies MUST NOT accept tokens from a URL, and agents MUST NOT send them there | 4.3 | Task 5, A-42 |
| G8 | Refresh MAY ask for fewer scopes, never more | 4.8 | Task 10 |
| G9 | Account Token rotation: if the Company returns a new `refresh_token`, the agent MUST use it from then on | 4.8 | Task 10 (the agent vault replaces it) |
| G10 | Account Tokens MUST NOT go in model context, **conversation messages**, logs or URLs | 4.8 | F12 extended to conversation messages, Task 16 |
| G11 | Discovery: follow redirects to HTTPS only. `organization.domain` matches the requested host **ignoring a leading `www.`**. Reject an unsupported **major** `protocol_version`. Ignore unknown fields and extensions. | 3, 3.1, 3.3 | Task 3 |
| G12 | Revocation needs the client assertion. An Account Token is accepted only from the `client_id` it was issued to, so revoking from another agent fails. | 4.8, 4.9 | Task 10, A-46 |
| G13 | MCP: protected resource metadata (RFC 9728) with `authorization_servers` including `auth.issuer`. MCP version 2025-06-18 or later. | 6 | Task 20 |

### Notes (no change needed)

- **The spec allows a stricter domain check than ours.** It says `jwks_uri` and `redirect_uris` must be on the same **domain** as `client_id`, while our `verifyAgent` requires the same **host**, which is stricter. That's fine for the demo, because everything is on `agent.ohare.id.au`, but a real Company would accept subdomains. This is recorded as a known strictness in Task 4.
- **Our opaque random Session Tokens are allowed.** The spec's examples show JWT-looking values, but tokens are opaque to the agent (4.2). A Company that puts its own credentials inside a token MUST encrypt it, which doesn't apply to us.
- **Revoking an Account Token signs its Sessions out but keeps them alive.** They continue signed out, and the agent renews them with its assertion (4.9). Our A-08 expectation (403 `sign_in_required` with the old signed-in token) matches.
- **`resource`-specific tokens:** our `apis` entries have no `resource`, so one DPoP Session Token works at all services except MCP (4.3).

## Checklist: every in-scope MUST mapped to a task or test

Who: **C** = Company, **A** = Personal Agent. Status: ✅ already in the plan, ➕ added by this spike, ⛔ out of scope for v1/v1.1.

### Section 3: Discovery

| Requirement | Who | Covered by | Status |
|---|---|---|---|
| Publish `poppy.json` at `https://{domain}/.well-known/poppy.json` | C | Task 3, M1 | ✅ |
| Follow redirects, each to an HTTPS URL | A | Task 3 | ➕ G11 |
| Don't use a document whose **major** version isn't supported | A | Task 3 | ➕ G11 |
| `organization.domain` matches the requested host (ignoring a leading `www.`). The post-redirect host doesn't count. | A | Task 3 (F1) | ✅ + ➕ the `www.` rule |
| Metadata `issuer` exactly equals `auth.issuer`. `poppy_domains` includes the domain. | A | Task 3 (F1) | ✅ |
| `poppy_domains` lists every domain naming the issuer | C | Task 3, plus Task 21 for the second company (separate issuer) | ✅ |
| Third-party extension names start with a domain | C/A | n/a: no extensions used | ⛔ |
| Ignore unsupported extensions and unknown fields | C/A | Task 3 (parser tests with extra fields) | ➕ G11 |

### Section 4.1: Agent identity

| Requirement | Who | Covered by | Status |
|---|---|---|---|
| `client_id` is an HTTPS URL returning the metadata | A/C | Tasks 3–4. The dev flag is the only exception (T-12). | ✅ |
| Metadata `client_id` equals the fetch URL | C | Task 4, A-09 area | ✅ |
| `jwks_uri` and `redirect_uris` are HTTPS on the same domain. JWKS holds public keys only. | C | Task 4, A-19 (stricter: same host) | ✅ |
| Unregistered or blocked agent gets `invalid_client` (401) | C | Task 4, A-09 | ✅ |

### Section 4.2: Starting a Session

| Requirement | Who | Covered by | Status |
|---|---|---|---|
| A stable, opaque, per-issuer User ID, never derived from personal data, even with a keyed hash | A | Task 4 (F2), T-18 | ✅ |
| JWT-bearer grant with assertion, client assertion and DPoP proof | A/C | Task 4 | ✅ |
| `expires_in` > 0 | C | Task 4 response test | ✅ |
| Renewal with `session_id`: same `client_id` and User ID, otherwise `invalid_session` | C | Task 4 | ➕ G1 |
| The agent doesn't depend on token contents | A | Task 4 (agent treats the token as an opaque string) | ✅ |
| Error codes: `invalid_client` 401, `invalid_grant` 400, `invalid_session` 400, `account_mismatch` 400, `invalid_dpop_proof`/`use_dpop_nonce` 400, `rate_limited` 429 | C | Tasks 4, 10; A-04, A-43, A-45 | ➕ E2, E3, G2, G6 |

### Section 4.3: Using Session Tokens

| Requirement | Who | Covered by | Status |
|---|---|---|---|
| APIs and conversations carry `Authorization: DPoP` plus a proof | A/C | Task 5, A-02 | ✅ |
| Company checks: signature, bound key, `htm`/`htu`, `iat` window, `jti` replay, `ath` | C | Task 2, Task 5, A-01, A-03, A-06, A-07 | ✅ |
| The agent supports nonces. Failures return `invalid_dpop_proof`/`use_dpop_nonce` with `WWW-Authenticate: DPoP`. | A/C | Tasks 4–5 | ➕ G5 |
| MCP: Bearer token requested without a proof, `resource` = MCP url. Bearer accepted only on MCP. DPoP required everywhere else. | A/C | Task 20, A-33 to A-35 | ✅ |
| Accept the token in `Authorization` without requiring cookies | C | Task 5 | ✅ |
| The agent sends a Session Token on every API/conversation request | A | Task 5 (`call()` always attaches one) | ✅ |
| The agent uses the newest Session Token for a Session | A | Task 10 (session cache replaces it) | ✅ |
| Never send tokens in a URL, and never accept them from one | A/C | Task 5, A-42 | ➕ G7 |
| Honour 429 `Retry-After` | A | Task 5 | ➕ G6 |

### Section 4.4: Signing in

| Requirement | Who | Covered by | Status |
|---|---|---|---|
| Direct Sign-In only when the User signs in themselves | A | Tasks 6, 8 (automation only in the harness) | ➕ E4 |
| Never grant beyond requested and allowed for the type | C | Task 7, A-23 | ✅ + ➕ G3 |
| Sign-in requests include `scope`. Missing, unknown or unavailable gives `invalid_scope`. | A/C | Task 7, A-44 | ➕ G3 |
| The agent checks the granted `scope` | A | Task 8 (F9) | ✅ |
| One account per Session. `account_mismatch` otherwise. | C | Task 10, A-43 | ➕ G2 |

### Section 4.5: Direct Sign-In

| Requirement | Who | Covered by | Status |
|---|---|---|---|
| PKCE S256 and `state` | A/C | Tasks 7–8, A-13, A-14, A-15 | ✅ |
| Consent shows the agent's name (and logo) and lets the user approve some or all scopes, or decline | C | Task 7 (plus the host, T-11) | ✅ |
| `redirect_uri` exactly matches the metadata | C | Task 7, A-16 | ✅ |
| Redirect with `code`, `state`, `iss`. On decline, `error=access_denied` plus `iss`. | C/A | Tasks 7–8 | ✅ + ➕ G4 |
| The agent checks that `iss` exactly matches | A | Task 8, A-05 | ✅ |
| Code exchange: verifier, client assertion, DPoP, `session_id`. The Session belongs to the same `client_id`. Reused or expired code gives `invalid_grant`. | C | Task 8, A-04, A-12, A-13 | ✅ |

### Section 4.8: Account Tokens

| Requirement | Who | Covered by | Status |
|---|---|---|---|
| Accept Account Tokens only at the token and revocation endpoints, only from the issuing `client_id` | C | Task 10, A-20, A-46 | ✅ + ➕ G12 (**E1:** not bound to the DPoP key) |
| The Session belongs to the same `client_id` and User ID, and is signed out or signed in to the same account | C | Task 10, A-04, A-43 | ➕ G2 |
| `scope` can narrow, never widen | C | Task 10 | ➕ G8 |
| Rotation: the agent uses the new `refresh_token` | A | Task 10 | ➕ G9 |
| Expired or revoked gives `invalid_grant`. The Session continues signed out. | C | Task 10, A-08 | ✅ |
| Stored as secrets. Never in model context, conversation messages, logs or URLs. | A | Task 8 (vault), Task 12 (F12), Task 16, A-22 | ✅ + ➕ G10 |

### Section 4.9: Signing out

| Requirement | Who | Covered by | Status |
|---|---|---|---|
| Revoke at `revocation_endpoint` with the client assertion. Sign out every Session signed in with it. | A/C | Task 10, A-08, A-46 | ✅ + ➕ G12 |
| Check signed-in state on each request (SHOULD) | C | Task 10 (F11) | ✅ |

### Section 6: APIs

| Requirement | Who | Covered by | Status |
|---|---|---|---|
| API `type` is `openapi` or `mcp` | C | Tasks 5, 20 | ✅ |
| Every listed API accepts Session Tokens: DPoP for OpenAPI, Bearer for MCP | C | Tasks 5, 20 | ✅ |
| MCP accepts only tokens for its url, enforces scopes, and publishes RFC 9728 metadata with `authorization_servers` ⊇ `auth.issuer` | C | Task 20 | ✅ + ➕ G13 |
| Errors `invalid_token` 401, `sign_in_required` 403, `insufficient_scope` 403 with `scope` attribute | C | Tasks 5, 9 | ✅ |

### Section 7: Conversations (v1.1)

| Requirement | Who | Covered by | Status |
|---|---|---|---|
| Reject other `client_id`, User or account. All return the same `conversation_not_found`. | C | Task 15, A-25 | ✅ |
| ID alphabet and length rules | C/A | Task 15 schema test | ✅ |
| Message IDs unique per User. Retry semantics. `message_id_conflict`. | A/C | Task 15, A-31 | ✅ |
| A message has at least one of `text`, `data`, `context`. `context` fields use the defined formats. | A | Task 15 schema test | ✅ |
| Skip unknown event types. Never compare or sort cursors. | A | Task 15 | ✅ |
| Every read includes `cursor`, `has_more`, `status`, `responder` | C | Task 15 | ✅ |
| Never act on `text-delta` | A | Task 17 | ✅ |
| Every POST/read includes `status` and `responder`. A `state` event on every change. Each Company message has `sender`. | C | Tasks 15, 18 | ✅ |
| `sender: human` only for the User's own words | A | Task 19 | ✅ |
| Parent must be open, same owner, not itself Direct, with one open Direct at a time | C | Task 19 | ✅ |
| Sign-in during a conversation: `authorization` event. A person at the Company is held to the same scopes. After account use, a not-signed-in token gets `sign_in_required`. | C | Tasks 16, 18 | ✅ (made explicit in Task 16) |

### Out of scope (v1 and v1.1)

- 4.6 Device Sign-In
- 4.7 Mediated Sign-In (MUST rate-limit, MUST NOT echo credentials, `secret` fields)
- Section 5 Web browsing (browser assertions, cookie rules)
- 3.3 Extensions beyond ignoring them

The WebMCP experiment (Task 23) uses an ordinary cookie session, not section 5.

## Evidence

The spec text was extracted from the live page, and every line containing MUST was listed with `grep -n MUST`. Each line in sections 3, 4.1–4.5, 4.8, 4.9, 6 and 7 is mapped above. The lines in 4.6, 4.7 and 5 are listed as out of scope.
