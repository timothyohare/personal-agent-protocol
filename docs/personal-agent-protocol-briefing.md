# Personal Agent Protocol ("Poppy"): what it is, what it means, how to try it

*Briefing note · 12 October 2026 · Poppy spec status: draft 0.1 (updated 9 Oct 2026)*

## TL;DR

- **What it is:** an open protocol for how a *consumer's own* AI agent finds a company, signs the user in, and gets things done through the company's APIs, website or company agent. Announced 6 Oct 2026 by Sierra and Meta, with Genesys, Instinct, Rocket, Shopify, Stripe and Walmart as named partners. Apache-2.0.
- **What it really is underneath:** standard OAuth 2.0 (plus PKCE, the device grant, DPoP and private-key client auth) with three additions. These are a discovery file (`/.well-known/poppy.json`), a `session_id` that ties one user's activity together across API, web and chat, and a conversation API that flags whether a human or an AI is speaking. These terms are defined in the [Glossary](#glossary).
- **Adoption:** effectively zero in production so far. It is six days old, and there are no published counts of users, agents or companies. OpenAI, Anthropic, Google and Amazon are not named. A competing protocol (PACT, from Decagon and Instinct) launched the same day.
- **Identity:** this is the cloud IAM problem again, with a third party added. The agent is identified by a URL that serves its public keys, and tokens are bound to a key so a stolen token is useless. Permissions are deliberately coarse for now: read and write, plus company-defined scopes.
- **For companies:** Poppy lowers the cost of agents comparing and switching between providers. Simple, comparable products will feel commoditisation pressure, while complex or trust-heavy ones less so.
- **For banks:** the draft as written isn't bank-ready. Its credential-sharing sign-in mode is a non-starter, and the coarse scopes don't fit payments. In Australia, the Consumer Data Right (CDR) already provides a regulated version of the same idea.

---

## 1. What Poppy covers

Most agent protocols cover one slice. Poppy tries to cover the whole interface between a personal agent and a company:

| Building block | What it does | Underlying standard |
|---|---|---|
| Discovery | A company publishes `/.well-known/poppy.json`. It names the OAuth issuer, the sign-in types offered, the APIs (OpenAPI or MCP), an optional company agent, and the extensions supported. | JSON, plus OAuth server metadata (RFC 8414) |
| Agent identity | The agent's `client_id` is an HTTPS URL that returns a metadata document. That document gives its name and logo, its public keys (`jwks_uri`) and the addresses sign-in may return to. | OAuth Client ID Metadata Document draft, also used by MCP |
| Sessions | A session starts signed out. The agent signs a short-lived JWT naming itself and an opaque per-company user ID, and the company returns a Session Token. | JWT bearer grant (RFC 7523) |
| Token binding | Every request carries a DPoP proof signed by a key the agent holds, so a copied token can't be replayed. MCP is the exception: it gets Bearer tokens restricted to that one server. | DPoP (RFC 9449), resource indicators (RFC 8707) |
| Sign-in | Three modes. **Direct:** the user signs in on the company's page (authorization code flow with PKCE). **Device:** a code is shown and the user signs in on their phone. **Mediated:** the agent sends the user's credentials itself. | RFC 6749, 7636, 8628. Mediated is custom. |
| Account Token | A long-lived refresh token that only works at the company's token endpoint, only for that agent, and only with the agent's private key. Revoking it signs the user out. | Refresh tokens, revocation (RFC 7009) |
| Web browsing | The agent's browser joins the same session via a signed assertion, and the company sets its own cookie. | Custom |
| Conversations | A JSON/HTTPS chat API with the company's agent. It supports long-polling or server-sent events, handoff to a human, and "direct" conversations where the user talks to the company themselves. Each message is flagged as from a human or an AI. The message format is in section 9.8. | Custom |
| Extensions | Payments, push notifications and similar are planned as extensions. | Custom |

The key design stance is a spectrum of access rather than all or nothing. Today, companies either block agents or the agent logs in as the person with full power. Poppy adds middle steps: anonymous browsing, then signed-in read access, then signed-in write access. The company decides which steps it offers, and the user decides how much to grant.

## 2. Status and adoption (as of 12 Oct 2026)

| | |
|---|---|
| Spec | Draft 0.1, published at personalagentprotocol.org. It explicitly allows breaking changes before a stable version. |
| Backers | Meta and Sierra lead, with Genesys, Instinct, Rocket, Shopify, Stripe and Walmart named by Sierra. Meta's post also lists NiCE and Decagon. |
| Live implementations | None publicly announced. No reference implementation has been released yet. |
| Users / agents / companies | No published numbers. The realistic first agents are Meta's Muse, Instinct, and Sierra-powered company agents. |
| Notable absences | OpenAI, Anthropic, Google, Amazon, Salesforce, Zendesk. Amazon reportedly blocked Meta's Muse agent from its retail site in September. |
| Competing or overlapping efforts | **PACT** (Decagon and Instinct): same problem, built on A2A, with open-source code and conformance tests. **Visa Trusted Agent Protocol:** Stripe and Shopify are in both camps. |

Read the current state as a credible draft with strong commerce backers, but no network effect yet. The test is whether a major agent maker (OpenAI, Anthropic, Google) or a major retailer outside the group adopts it.

## 3. Where it sits among agent protocols

These protocols are mostly layers rather than rivals:

| Layer | Question it answers | Protocols |
|---|---|---|
| Is this a bot? | Which automated client is hitting my site? | Cloudflare Web Bot Auth, agent-detection models |
| **Whose agent, and what may it do?** | Which agent, acting for which customer, with what consent? | **Poppy**, PACT |
| How do agents talk? | Agent to tool, and agent to agent | MCP (tools and data), A2A (peer agents; 150+ organizations, v1.0) |
| Agent in the user's browser | Which tools does this page offer an in-browser agent? | WebMCP (W3C Community Group draft; Chrome and Edge origin trials). See [Poppy vs WebMCP](poppy-vs-webmcp.md). |
| Commerce and payment | Cart, checkout, payment authorisation | ACP (OpenAI and Stripe), UCP (Google and Shopify), AP2, Visa TAP, Mastercard Agent Pay |

Poppy sits *above* MCP and OpenAPI. A company can expose either one behind Poppy's discovery and sign-in. A2A says authorization is up to each implementation, and Poppy is one answer to exactly that gap.

## 4. Identity: is this cloud IAM again?

Mostly yes, and the mapping is close:

| Cloud / AWS concept | Poppy equivalent |
|---|---|
| Principal identity (role ARN, OIDC issuer) | Agent `client_id`, an HTTPS URL serving metadata and public keys |
| Trust policy / federation | The company fetches the agent's metadata and keys. It may also keep allow or block lists, or require pre-registration. |
| SigV4 request signing | DPoP proof on every request: method, URL and timestamp, signed with the agent's key |
| STS short-lived credentials | Session Token, lasting hours rather than days |
| Long-lived credential | Account Token (refresh token), bound to the agent's identity |
| IAM policy actions | Scopes: `poppy:read`, `poppy:write`, plus company-defined custom scopes |
| Pairwise / anonymous identity | A per-company opaque user ID, never derived from personal data, so companies can't correlate users |

**What's different from cloud IAM:**

1. **Three parties, not two.** In the cloud, one authority (the account owner) writes policy for its own principals. Here the user grants access, the company sets the ceiling, and the agent operates in between. The agent belongs to neither of them.
2. **A much simpler policy language, so far.** There are no conditions, amount limits, time windows or per-action rules yet. Fine-grained limits are listed as future work. For most retail that's fine. For money movement it isn't.
3. **The agent's identity is only as strong as its domain.** A URL proves *which software* is calling, not that the software is trustworthy. There is no attestation or "know your agent" (KYA) layer, so companies fall back on allow lists.
4. **Some rules rely on trust.** The spec admits a company can't always tell whether the user really signed in themselves or the agent filled in the page. The only remedy is revoking the agent's `client_id`.

**Will we see a "simpler IAM" for personal agents?** Poppy *is* that first attempt: a coarse permission set that a person can actually understand and approve. Expect it to get richer over time, with per-action scopes, spending limits, and signed receipts of what was done (PACT already has receipts). Expect companies to keep the detailed policy on their side, behind custom scopes.

## 5. Why not just use REST?

Poppy *is* REST: JSON over HTTPS plus standard OAuth. The point is standardising everything *around* the API that every company currently invents for itself:

- **Discovery:** how does an agent find your API at all?
- **Agent identity:** today agents use shared API keys or pretend to be a browser.
- **Consent semantics:** what read versus write means, and how the user grants and revokes access.
- **Session continuity:** one session across API, web and chat.
- **Human-or-AI signalling:** each side knows who it's talking to and adapts.

Without a standard, every agent needs a bespoke integration with every company (N×M), so in practice agents scrape websites. With one, it becomes N+M.

## 6. What it means for companies: race to the cheapest?

**Arguments that it commoditises:**

- Agents compare on structured attributes (price, rate, fees, delivery time) and don't see brand or UX.
- Switching costs fall when an agent does the paperwork.
- The customer's attention moves to the agent, so the company owns less of the relationship.

**Arguments that it doesn't:**

- Companies control which agents get in and what they may do. They can refuse, rate-limit or require their own company agent.
- The "company agent" door lets businesses negotiate, upsell and retain customers inside the conversation.
- Trust, service recovery, bundles and regulation still differentiate when things go wrong.
- Agent makers need companies to participate, which gives companies some leverage, at least early on.

**Likely outcome:** simple, comparable products feel real margin pressure. Complex, advice-heavy or trust-heavy products (mortgages, wealth, insurance claims) keep more differentiation. The strategic question for each company is which door it wants to be: a commodity API, or a company agent the customer's agent has to talk to.

## 7. What it means for banks (Australian lens)

**Why the draft as written isn't bank-ready:**

- **Mediated sign-in** (the agent sends the user's credentials) conflicts with bank terms and conditions and the ePayments Code. Australian banks will offer the Direct and Device modes only.
- **`poppy:write` is far too coarse for money movement.** Banks would need custom scopes (for example, view balances, pay a saved payee, pay a new payee), step-up authentication, amount limits and cooling-off periods.
- **Liability follows authorisation.** If an agent's payment is disputed, the bank needs evidence of what the customer actually authorised. That means signed receipts and audit trails the draft doesn't yet define.
- **Scams.** A standard agent channel is also a standard attack channel. Fraud and scam controls (such as behavioural signals and confirmation of payee) need to apply to agent sessions too.

**The CDR angle:**

- Open banking under the CDR already does accreditation, consent and financial-grade OAuth for banking data.
- Action initiation (write access, including payment initiation) has been law since August 2024. Treasury has flagged low-risk payment and credit card balance transfer use cases as likely early actions, but the specific action types are still being declared.
- Expect regulators and banks to ask whether consumer agents should come through the CDR (accredited and liability-defined) rather than an industry protocol.
- A plausible path is that banks use Poppy for discovery, read-only servicing and conversations, and route money movement through the CDR or payment-network protocols.

**Commercial impact:**

- Agents will compare savings and term deposit rates, fees and FX margins automatically. That increases rate competition and reduces "lazy money" balances.
- Servicing tasks (disputes, card replacement, document requests) are good candidates for agent channels. They lower cost-to-serve if the bank controls the scope.

**Horizontal platform pieces that become strategic:**

- Agent detection and customer protection, for agents that don't declare themselves.
- Notifications. Poppy plans a push extension so a company can notify the customer's agent.
- Task and approval surfaces where the agent hands a decision back to the customer.
- Document management for agent-requested statements and documents.

**No-regret moves now:**

1. Classify every digital action as read, reversible write, money-moving or account-control. That list becomes your scope model.
2. Measure how much agent traffic is already arriving through web, app and contact centre.
3. Make sure the identity platform can issue key-bound tokens (DPoP), not just bearer tokens.
4. Track Poppy, PACT and CDR action initiation together, rather than as separate topics.

## 8. Open questions to watch

- Does a major agent maker (OpenAI, Anthropic, Google) adopt Poppy, or does PACT or A2A win?
- Will Poppy define per-action limits and signed receipts, or leave them to extensions?
- Does a "know your agent" (KYA) attestation layer emerge, and who issues it: payment networks, platforms or regulators?
- How does it interact with CDR action initiation and payment-network agent protocols?

---

## 9. Build sketch: a minimal Poppy company and agent

**Goal:** implement the core loop end to end, to learn how discovery, agent identity, sessions, DPoP and sign-in fit together. Skip the conversation API, web browsing, device and mediated sign-in, and MCP for v1.

### 9.1 The pieces

| Component | Where | What it does |
|---|---|---|
| **Company: "Tipping Co"** | `tipping.ohare.id.au` (or a local tunnel) | An NRL tipping service. It publishes `poppy.json` and OAuth metadata, runs a small authorization server, and serves an OpenAPI API. |
| **Agent identity host** | `agent.ohare.id.au` | Static files: `agent.json` (client metadata) and `jwks.json` (public keys), plus `/oauth/callback`. |
| **Personal agent** | Local CLI first, then a LangGraph tool | Discovers the company, starts a session, calls APIs, and handles sign-in when needed. |

Both sides need public HTTPS, because the company has to fetch the agent's metadata. Options: two Lambda function URLs, Amplify, or a Cloudflare tunnel for local development. Use TypeScript and the [`jose`](https://github.com/panva/jose) library for all JWT, JWK and DPoP work.

**Why hand-roll the authorization server for v1:** to see every check happen. For anything real, put an off-the-shelf authorization server (Keycloak, node-oidc-provider, Ory) in front. They already support DPoP, private-key client auth, PKCE and refresh tokens, so you would only add the JWT-bearer session grant and `session_id`.

### 9.2 The company's API surface

| Endpoint | Access | Notes |
|---|---|---|
| `GET /api/fixtures` | Signed-out session | Public data |
| `GET /api/ladder` | Signed-out session | Public data |
| `GET /api/me/tips` | `poppy:read` | The user's tips |
| `POST /api/me/tips` | `poppy:write` | Submit a tip for a round |
| `GET /api/me/score` | custom `standings` scope | Shows how custom scopes work |

### 9.3 Company files

**`/.well-known/poppy.json`**

```json
{
  "protocol_version": "0.1",
  "organization": { "name": "Tipping Co", "domain": "tipping.ohare.id.au" },
  "auth": {
    "issuer": "https://tipping.ohare.id.au",
    "direct": { "scopes": ["poppy:read", "poppy:write", "standings"] },
    "custom_scopes": { "standings": "See your position on the competition ladder" }
  },
  "apis": [
    {
      "type": "openapi",
      "url": "https://tipping.ohare.id.au/openapi.json",
      "description": "Fixtures, ladder, your tips and score"
    }
  ]
}
```

**`/.well-known/oauth-authorization-server`**

```json
{
  "issuer": "https://tipping.ohare.id.au",
  "authorization_endpoint": "https://tipping.ohare.id.au/oauth/authorize",
  "token_endpoint": "https://tipping.ohare.id.au/oauth/token",
  "revocation_endpoint": "https://tipping.ohare.id.au/oauth/revoke",
  "poppy_domains": ["tipping.ohare.id.au"]
}
```

### 9.4 Agent files

**`https://agent.ohare.id.au/agent.json`**

```json
{
  "client_id": "https://agent.ohare.id.au/agent.json",
  "client_name": "Tim's Agent",
  "jwks_uri": "https://agent.ohare.id.au/jwks.json",
  "redirect_uris": ["https://agent.ohare.id.au/oauth/callback"],
  "token_endpoint_auth_method": "private_key_jwt"
}
```

Generate an ES256 key pair once. Publish the public JWK, with a `kid`, in `jwks.json`, and keep the private key in a secrets store. Keep the DPoP keys separate: generate them per user per company, and never publish them.

### 9.5 Agent-side code (key pieces)

```ts
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createHash, randomBytes } from "node:crypto";

const CLIENT_ID = "https://agent.ohare.id.au/agent.json";
const rid = () => randomBytes(16).toString("base64url"); // 128-bit jti

// Client assertion (private_key_jwt): proves "I am this agent" at the token endpoint
async function clientAssertion(tokenEndpoint: string, signingKey: CryptoKey, kid: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(CLIENT_ID).setSubject(CLIENT_ID).setAudience(tokenEndpoint)
    .setIssuedAt().setExpirationTime("60s").setJti(rid())
    .sign(signingKey);
}

// Session assertion: "I am this agent, acting for user X at your company"
async function sessionAssertion(tokenEndpoint: string, userId: string, signingKey: CryptoKey, kid: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(CLIENT_ID).setSubject(userId).setAudience(tokenEndpoint)
    .setIssuedAt().setExpirationTime("60s").setJti(rid())
    .sign(signingKey);
}

// DPoP proof: signed fresh for every request, bound to method + URL (+ token hash)
const dpopKeys = await generateKeyPair("ES256");
const dpopJwk = await exportJWK(dpopKeys.publicKey);

async function dpopProof(method: string, url: string, accessToken?: string, nonce?: string) {
  const u = new URL(url); u.search = ""; u.hash = "";
  const claims: Record<string, unknown> = { htm: method, htu: u.toString(), jti: rid() };
  if (accessToken) claims.ath = createHash("sha256").update(accessToken).digest("base64url");
  if (nonce) claims.nonce = nonce;
  return new SignJWT(claims)
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: dpopJwk })
    .setIssuedAt()
    .sign(dpopKeys.privateKey);
}
```

**Agent flow:**

1. **Discover.** Fetch `poppy.json`. Check that `organization.domain` matches the host you asked for. Fetch the OAuth metadata from `auth.issuer`, check that `issuer` matches exactly and that `poppy_domains` includes the domain.
2. **Pick the user ID.** Look up (or randomly create and store) a user ID for this issuer. Never derive it from an email or name.
3. **Start a session.** POST to `token_endpoint` with the JWT-bearer grant, the session assertion, the client assertion and a DPoP proof. You get a signed-out Session Token and a `session_id`.
4. **Call public APIs.** For example `GET /api/fixtures`, with `Authorization: DPoP <token>` plus a fresh proof.
5. **Hit a sign-in error.** `GET /api/me/tips` returns 403 `sign_in_required`.
6. **Direct sign-in.** Build the authorize URL with PKCE and `state`, then open it in the user's browser. The callback receives `code`, `state` and `iss`; check that `iss` equals the company's issuer.
7. **Exchange the code.** POST the code, verifier, `session_id`, client assertion and DPoP proof. You get an Account Token and a signed-in Session Token. Check the granted `scope`, since the user may have approved less than you asked for.
8. **Act.** `POST /api/me/tips`.
9. **Later runs.** Use the Account Token with the refresh grant to start new signed-in sessions without asking the user again. Store it as a secret, never in the model's context.
10. **Sign out.** POST the Account Token to `revocation_endpoint`.

### 9.6 Company-side checks (the security core)

**Token endpoint, JWT-bearer grant:**

```ts
import { createRemoteJWKSet, jwtVerify, EmbeddedJWK, calculateJwkThumbprint } from "jose";

async function verifyAgent(clientId: string, clientAssertion: string, tokenEndpoint: string) {
  const meta = await (await fetch(clientId)).json();               // cache per HTTP headers
  if (meta.client_id !== clientId) throw "invalid_client";
  const host = new URL(clientId).host;
  if (new URL(meta.jwks_uri).host !== host) throw "invalid_client";
  const jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
  await jwtVerify(clientAssertion, jwks, { issuer: clientId, audience: tokenEndpoint });
  return { meta, jwks };
}

async function verifyDpop(proof: string, method: string, url: string, accessToken?: string) {
  const { payload, protectedHeader } = await jwtVerify(proof, EmbeddedJWK, {
    typ: "dpop+jwt", algorithms: ["ES256"], maxTokenAge: "60s",
  });
  if (payload.htm !== method || payload.htu !== url) throw "invalid_dpop_proof";
  if (seenJti(payload.jti as string)) throw "invalid_dpop_proof";       // replay window
  if (accessToken && payload.ath !== sha256b64url(accessToken)) throw "invalid_dpop_proof";
  return calculateJwkThumbprint(protectedHeader.jwk!);                 // the key ID to bind to
}
```

Then:

- Verify the session assertion against the same `jwks`. Check that `iss` equals the authenticated `client_id`, that `aud` equals the token endpoint, and that its `jti` hasn't been used before.
- Create a session record (`session_id`, `client_id`, user ID, account = none, DPoP key thumbprint).
- Issue an opaque random Session Token, held in a map keyed to the session, with a one-hour expiry.

**API middleware** (on every request):

1. Read `Authorization: DPoP <token>` and look up the token.
2. Verify the DPoP proof, including `ath`. Check that its key thumbprint equals the thumbprint the token is bound to.
3. Check the token is signed in and has the scope the route needs. Otherwise return 403 `sign_in_required` or `insufficient_scope`, with a `WWW-Authenticate: DPoP` header.
4. Check, on every request, that the session is still signed in, so that revocation takes effect immediately.

**Authorize endpoint:**

- Show a simple login form, then a consent screen with the agent's `client_name` and a checkbox per scope.
- Validate that `redirect_uri` exactly matches an entry in the agent's metadata.
- Redirect back with `code`, `state` and `iss`.

**Storage:** in-memory maps for v1. DynamoDB later, with TTLs on sessions, codes and replay records.

### 9.7 Milestones

1. **Static files.** `poppy.json`, the OAuth metadata, `agent.json` and `jwks.json` are live over HTTPS.
2. **Signed-out session.** The agent starts a session and reads `/api/fixtures` using DPoP.
3. **Direct sign-in.** The full loop works and the agent writes a tip.
4. **Account Token reuse and revocation.** Kill the session, restart it signed in, then sign out and confirm that `/api/me/tips` returns 403.
5. **Attack tests.** Each of these must fail: replay a proof, send the token without a proof, send the token with a different key's proof, use another agent's `session_id`, use a mismatched `iss` on the callback.
6. **LLM in the loop.** Wrap the agent as a LangGraph tool (`poppy_call(company, method, path, body)`) that handles sessions and sign-in transparently. The model never sees the tokens.
7. **Stretch goals:**
   - Add an MCP server with a resource-specific Bearer token.
   - Add the Poppy conversation endpoint with a Claude-backed "company agent".
   - Point the agent at a second company to feel the N+M benefit.
   - Try PACT's reference implementation for comparison.

### 9.8 Conversation message format (spec section 7)

The reference for the conversation stretch goal, taken from draft 0.1. The company lists the endpoint in `poppy.json` under `agent.protocols`, as an entry with `"type": "poppy"`. Every request carries `Authorization: DPoP <Session Token>` plus a fresh `DPoP` proof. `session_id` is not sent.

| Request | Purpose |
|---|---|
| `POST {endpoint}` | Start a conversation with its first message |
| `POST {endpoint}/{id}/messages` | Send another message |
| `GET {endpoint}/{id}/events` | Read events by long-poll (`?cursor=…&wait=30`) or SSE |
| `POST {endpoint}/{id}/handoff` | Ask for a person at the company |
| `POST {endpoint}/{id}/close` | Close the conversation |

**Sending a message (agent → company):**

```json
{
  "message": {
    "id": "msg_Yq3v8LrT0aWc5NkE",
    "sender": "agent",
    "text": "The jacket from order #1042 isn't warm enough. The user wants to return it.",
    "context": { "locale": "en-US", "time_zone": "America/Los_Angeles", "user_available": true }
  }
}
```

| Field | Req. | Meaning |
|---|---|---|
| `id` | Yes | Chosen by the agent and unique for the user. A resend with the same ID and content is treated as a retry. The same ID with different content returns 409 `message_id_conflict`. |
| `sender` | Yes | `agent` if the agent wrote it. `human` only for the user's own words, so a summary or translation is still `agent`. |
| `text` | No | Natural language, with no JSON or markup. |
| `data` | No | A JSON object for structured details. The protocol doesn't define its keys. |
| `context` | No | `locale`, `time_zone`, `user_available` and similar. Fields left out keep their previous values. Only the agent sends it. |

A message needs at least one of `text`, `data` or `context`. The first POST returns 201 with `conversation_id`, `status` and `responder`, and later messages return 202 with the same fields. Adding `?wait=10` (plus `cursor` if you have one) to either POST returns the reply in the same response.

**Reading events (company → agent):**

```json
{
  "conversation_id": "cnv_8f3Kd2",
  "events": [
    {
      "id": "evt_c2",
      "type": "message",
      "created_at": "2026-10-08T19:03:00Z",
      "message": {
        "id": "msg_r2Kq",
        "role": "company",
        "sender": "agent",
        "text": "I can do that. The insulated version would be warmer. Want to exchange instead for $70 more?",
        "data": { "replacement_sku": "stormline-insulated-m", "price_difference": 70 }
      }
    }
  ],
  "cursor": "evt_c2",
  "has_more": false,
  "status": "idle",
  "responder": "agent"
}
```

- **Event types:**
  - `message`
  - `state` (`status` or `responder` changed)
  - `authorization` (sign-in or more scopes needed)
  - `user_requested` (the company wants to talk with the user directly)
  - `direct_opened` / `direct_closed`

  The agent must skip types it doesn't recognise.
- **Cursors:** each event `id` is also a cursor. Cursors are opaque, so never compare or sort them. If `has_more` is true, read again straight away. An expired cursor returns 410 `cursor_expired`.
- **SSE:** send `Accept: text/event-stream`, then reconnect with `Last-Event-ID`. `text-delta` events carry partial text to display, but the agent must not act on them until the full `message` event arrives.

**Human or AI:**

| Field | Where | Values | Meaning |
|---|---|---|---|
| `role` | Each message in events | `user` / `company` | Which side it came from |
| `sender` | Each message | `agent` / `human` | Whether an AI or a person wrote it |
| `responder` | Every response, plus `state` events | `agent` / `human` | Who is handling the company side right now |
| `status` | Every response, plus `state` events | `working` / `idle` / `queued` / `closed` | Where the conversation is up to |

**Handoff and direct conversations:**

- **Handoff:** POST `{}` to `/handoff`. The status becomes `queued`. Then either:
  - a person joins, so `responder` becomes `human`, or
  - nobody is available, so the status returns to `idle` and `responder` stays `agent`.
- **Direct conversations:** start a new conversation with `"parent_conversation_id"`. The user takes part themselves. While it is open, the parent returns 409 `direct_conversation_open`.

**Errors:**

| Error | Status |
|---|---|
| `invalid_cursor` | 400 |
| `conversation_not_found` | 404 |
| `conversation_closed`, `direct_conversation_open`, `message_id_conflict` | 409 |
| `cursor_expired` | 410 |

Token errors also apply: 401 `invalid_token`, 403 `sign_in_required`, 403 `insufficient_scope`.

**IDs:** conversation, message and event IDs are 1 to 256 characters from the URL-safe base64 alphabet (letters, digits, `-` and `_`). They should start with a prefix for their kind (`cnv_`, `msg_`, `evt_`). The company chooses conversation and event IDs, and the agent chooses its own message IDs. Neither side may depend on the other's ID format. A conversation belongs to the `client_id` and user ID that started it, or to the account once it uses one. Any matching Session can continue it, so it can outlast the Session that started it.

### 9.9 Sessions and `session_id` (spec section 4)

The session-start response from the `token_endpoint`:

```json
{
  "access_token": "eyJhbGciOi…Lm9x",
  "token_type": "DPoP",
  "expires_in": 3600,
  "scope": "",
  "session_id": "ses_2Lm0",
  "signed_in": false
}
```

- `access_token` is the Session Token. `token_type` is `DPoP`, or `Bearer` for an MCP token requested without a proof.
- `expires_in` is chosen by the company and must be greater than 0. Session Tokens should last hours, not days.
- `scope` is a space-separated list of the account scopes granted. A signed-out token has none.
- `signed_in` says whether the Session is signed in to a company account.
- `session_id` identifies the Session. The spec says "It is not a credential." It has **no defined format**. The examples use a `ses_` prefix, such as `ses_2Lm0`, so treat it as opaque.

**Where `session_id` appears:**

| Direction | Where |
|---|---|
| Company → agent | The token response for session start, sign-in and mediated sign-in |
| Agent → company (form parameter) | Session renewal, the Direct Sign-In code exchange, the Device Sign-In poll, the Account Token refresh, and the MCP Bearer token request |
| Browser assertion | The `session_id` claim names the Session the agent's browser joins, signed in or out |
| Not sent | API and conversation requests, which carry only `Authorization: DPoP <token>` and the `DPoP` proof |

When an agent refreshes with the Account Token and includes `session_id`, it gets a token for that Session, which signs the Session in if it was signed out. Without `session_id`, it starts a new Session that is already signed in.

**The session assertion** (the JWT the agent signs to start a Session):
- `iss` is the agent's `client_id`.
- `sub` is the per-company user ID.
- `aud` is the company's `token_endpoint`, as a single string so the assertion can't be used at another company.
- `iat` and `exp` give a short lifetime, about one minute.
- `jti` is at least 128 random bits. The company rejects one it has already seen.

The company verifies the assertion against the agent's `jwks_uri` and checks that `iss` equals the authenticated `client_id`.

---

## Glossary

| Term | Definition |
|---|---|
| **PKCE** (Proof Key for Code Exchange, RFC 7636) | Protects the authorization code flow used by Direct Sign-In. Before sending the user to sign in, the agent creates a random secret, the *code verifier*. Only its hash, the *code challenge*, goes in the authorize URL. When the agent exchanges the returned `code` for tokens, it sends the verifier, and the company checks that it hashes to the challenge. An intercepted `code` is useless without the verifier. |
| **Device grant** (RFC 8628) | Sign-in for devices without a convenient browser, used by Device Sign-In. The agent gets a device code and a short user code. The user enters the user code on their phone at the company's site and approves there, while the agent polls the token endpoint until approval arrives. The user's password only ever goes into the company's own page. |
| **DPoP** (Demonstrating Proof of Possession, RFC 9449) | Binds a token to a key pair the agent holds. With every request, the agent signs a fresh JWT proof. It contains the HTTP method (`htm`), the URL (`htu`), a unique `jti`, the issue time and a hash of the access token (`ath`). The company checks the signature, the method and URL, the proof's age, that the `jti` hasn't been used before, and that the key's thumbprint matches the token. A stolen token or captured proof can't be replayed. |
| **Bearer token** | A token that anyone holding it can use, like cash. Poppy uses Bearer tokens only for MCP, restricted to one server via resource indicators (RFC 8707). |
| **Private-key client auth** (`private_key_jwt`) | The agent proves its identity at the token endpoint by signing a short-lived *client assertion* JWT with the key published at its `jwks_uri`, instead of using a shared client secret. |
| **`client_id`** | The agent's identity: an HTTPS URL that returns its metadata document (name, logo, `jwks_uri`, `redirect_uris`). |
| **User ID** | An opaque, per-company identifier for the user, chosen by the agent and never derived from an email or name, so companies can't correlate users. |
| **Session** | One user's activity with one company, which starts signed out. It ties together API calls, web browsing and conversations. |
| **`session_id`** | The company-issued identifier for a Session. It isn't a credential and its format is opaque (see 9.9). |
| **Session Token** | A short-lived OAuth access token for a Session, lasting hours. It is DPoP-bound and sent as `Authorization: DPoP <token>`. |
| **Account Token** | A long-lived OAuth refresh token issued after sign-in. It works only at the company's token endpoint, only for that agent, and only with the agent's key. Revoking it signs the user out. |
| **Direct / Device / Mediated sign-in** | The three sign-in modes. **Direct:** the user signs in on the company's page, using the authorization code flow with PKCE. **Device:** the user enters a code on another device, using the device grant. **Mediated:** the agent sends the user's credentials itself, which is custom to Poppy. |
| **Company Agent** | The company's own AI agent, reached through the conversation API. |
| **`role` / `sender` / `responder`** | Conversation fields. `role` (`user`/`company`) gives the side a message came from. `sender` (`agent`/`human`) says whether an AI or a person wrote it. `responder` (`agent`/`human`) says who is handling the company side right now (see 9.8). |
| **Direct Conversation** | A new conversation, linked to an earlier one by `parent_conversation_id`, in which the user talks with the company themselves. |
| **WebMCP** | A proposed browser API (`document.modelContext.registerTool()`) that lets a web page offer MCP-shaped tools to an agent running inside the user's browser. It uses the user's existing logged-in session, so the site can't tell that an agent is calling. Compared with Poppy in [Poppy vs WebMCP](poppy-vs-webmcp.md). |
| **SSE** (server-sent events) | A one-way HTTP stream from server to client. It is the optional alternative to long-polling for reading conversation events. |
| **Long-polling** | The server holds a read request open for up to `wait` seconds until there is something to return. |

---

## Sources

- Personal Agent Protocol site and draft 0.1 spec: https://personalagentprotocol.org, https://personalagentprotocol.org/docs/spec
- Sierra announcement: https://sierra.ai/blog/introducing-personal-agent-protocol
- eesel, "what shipped vs promised" (partner lists, PACT, comparison): https://www.eesel.ai/blog/personal-agent-protocol
- The Next Web, coverage including the Visa Trusted Agent Protocol overlap: https://thenextweb.com/news/personal-agent-protocol-sierra-meta
- YourStory, coverage including the Amazon/Muse block: https://yourstory.com/ai-story/ai-agents-common-language-meta-walmart-stripe
- PACT repository: https://github.com/openpactprotocol/openpactprotocol
- WebMCP explainer and implementation status: https://github.com/webmachinelearning/webmcp (comparison in [poppy-vs-webmcp.md](poppy-vs-webmcp.md))
- KodeKloud, A2A vs MCP (A2A v1.0, 150+ organizations): https://kodekloud.com/blog/a2a-vs-mcp-agent-communication-protocols-explained-for-devops/
- The Banking Scene, "AI and the Agentic Future of Banking": https://thebankingscene.com/resources/ai-and-the-agentic-future-of-banking/
- FinTech Futures, Sibos 2026 on agentic authorisation and liability: https://www.fintechfutures.com/ai-in-fintech/sibos-2026-digital-finance-in-an-ai-driven-economy-when-the-agent-does-the-buying-who-owns-the-customer
- CDR action initiation status: https://andrewbrien.substack.com/p/issue-57-the-cdr-turns-5-years-old, https://www.bankingday.com/government-to-add-payment-initiation-to-cdr
