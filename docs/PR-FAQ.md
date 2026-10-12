# PR/FAQ: Tipping Co Poppy demo

*Working-backwards document · Draft · 12 October 2026 · The press release is written as if the demo has shipped. All companies and quotes are illustrative, for an internal audience.*

---

## Press release

### Your AI agent can now tip the footy for you, safely: a working Poppy demo shows how personal agents should sign in

**A small open-source build makes the new Personal Agent Protocol tangible. You can watch a personal AI agent discover a company, sign the user in without seeing their password, and act with only the permissions the user granted.**

**SYDNEY, [launch date]:** Today we're releasing a working demonstration of the Personal Agent Protocol ("Poppy"), the draft standard announced by Sierra and Meta on 6 October 2026 for how a consumer's own AI agent works with a company. The demo pairs "Tipping Co", a fictional NRL tipping service, with a personal agent. The agent finds the company, reads public fixtures, asks the user to sign in when it needs to, submits a tip, and signs out. Every security check is visible, and every attack we could think of is shown failing.

**The problem.** People are starting to hand everyday tasks to AI agents, but companies have only two options today. They can block agents outright, or let the agent log in *as* the person, with their password and full power. Neither option is safe, and neither scales. Teams evaluating Poppy have a draft spec and no reference implementation to learn from.

**The solution.** The demo implements Poppy's core loop:
- discovery through `/.well-known/poppy.json`
- an agent identity that is just a URL serving public keys
- a signed-out session for public data
- sign-in on the company's own page, using PKCE, with a consent screen that lists each permission
- tokens bound to a key the agent holds (DPoP), so a stolen token is useless

The agent can be driven by an LLM, which never sees a token. A suite of 29 automated attacks, including replayed proofs, swapped keys, hijacked sessions and mixed-up sign-in responses, shows each one being refused.

"I wanted to understand Poppy by building it, not by reading about it," said Tim O'Hare, who built the demo. "The interesting part isn't the happy path. It's watching a copied token fail because the attacker doesn't have the key, and seeing exactly which line of code stopped it."

**How it works.** Run one command to start Tipping Co and the agent locally, or open the public demo. Ask the agent "what are this round's fixtures?" and it answers straight away, with no sign-in needed. Say "tip the Storm" and it explains that it needs your permission. Your browser opens Tipping Co's own sign-in page, which shows the agent's name and web address and lets you tick the permissions you're granting. The agent confirms before it submits the tip. Signing out from the agent revokes its access instantly.

"Our security team had read the Poppy spec three times and still argued about what DPoP actually buys us," said an illustrative identity architect at an Australian bank. "Twenty minutes with the attack table settled it, and showed us what our own authorization server would need."

**Get started.** Clone the repo, run `npm install && npm run dev:local`, then `npm run agent -- fixtures`. The briefing, PRD, verification guide and security review are in `docs/`.

---

## External FAQ (people who will use or watch the demo)

**Q: What is Poppy, in one sentence?**
A: Standard OAuth 2.0 (plus PKCE, DPoP and private-key client auth) with three additions:
- a discovery file
- a `session_id` that links a user's activity across API, web and chat
- a conversation API that says whether a human or an AI is speaking

See the [Glossary](personal-agent-protocol-briefing.md#glossary).

**Q: Does the agent ever see my password?**
A: No. You sign in on Tipping Co's page in your own browser. The agent receives only a one-time code, which is useless without a secret (the PKCE verifier) that only the agent holds.

**Q: What can the agent do once I sign in?**
A: Only what you ticked: read your tips, submit tips, and/or see your ladder position. Unticked permissions are refused with `insufficient_scope`.

**Q: What if someone steals the agent's token?**
A: Every request must carry a fresh proof signed with a private key that never leaves the agent. Without that key, the token is refused (attacks A-02 and A-03).

**Q: How do I revoke access?**
A: Run `npm run agent -- signout` (or the chat equivalent). The company checks the signed-in state on every request, so access stops on the next call.

**Q: Is this production-ready?**
A: No. It is a learning and demonstration build with in-memory storage and a hand-rolled authorization server. See SecurityReview section 6 for what production would need.

**Q: Which parts of Poppy are not included?**
A: Device and Mediated sign-in, web browsing and extensions. The conversation API and MCP arrive in v1.1.

**Q: Can I talk to Tipping Co's own agent, or to a real person?**
A: In v1.1, yes. Your agent can open a conversation with Tipping Co's Claude-backed agent, which can read fixtures and, if you've signed in, submit tips for you. Every message says whether a person or an AI wrote it (`sender`), and every response says who is handling the company side right now (`responder`). Your agent can ask for a person (handoff). If the company asks to speak with you directly, your agent opens a direct conversation where you type yourself.

## Internal FAQ (stakeholders deciding whether this is worth doing)

**Q: Why build this instead of waiting for an official reference implementation?**
A: There isn't one. The spec is six days old, and a competing protocol (PACT) launched the same day. Building it is the fastest way to form a grounded view on adoption, especially for banks, where key-bound tokens and consent granularity are the deciding issues.

**Q: What does it cost?**
A: v1 is 12 focused tasks across 5 phases, and v1.1 adds 10 more across 5 phases (see [TODO.md](TODO.md)). Infrastructure is AWS Lambda function URLs, CloudFront and DynamoDB on demand, which should cost a few dollars a month at demo traffic. LLM usage (the personal agent plus the Claude-backed company agent) is the main variable cost, and is capped by per-session rate limits and a budget alarm.

**Q: What are the biggest risks?**
A:
1. The spec is draft 0.1, so breaking changes are expected. We pin the version and keep protocol constants in one package.
2. A hand-rolled authorization server may contain bugs. We mitigate this with the attack suite, mutation testing and a sign-off checkpoint. It is never deployed beyond the demo.
3. The LLM could leak or misuse credentials. Tokens never enter the model's context, and writes need confirmation.

**Q: How will we know it worked?**
A: Each item is backed by a gate that fails if the claim is false:
- All six milestones pass [HowToVerify.md](HowToVerify.md).
- All 29 v1 attacks fail closed.
- The mutation score is at least 80% on the auth code.
- A cold-start live demo runs in under 10 minutes.

**Q: What does this tell a bank?**
A: Four things:
1. Whether its identity platform can issue DPoP-bound tokens (a no-regret move from briefing section 7).
2. How coarse Poppy's scopes feel next to real payment actions.
3. That only Direct and Device sign-in are acceptable.
4. Where Poppy would sit alongside CDR action initiation.

**Q: How is this different from WebMCP?**
A: WebMCP lets a web page offer tools to an agent running inside your own logged-in browser. It's easy for sites, but the site can't tell an agent is acting, and there's no separate consent. Poppy gives the agent its own identity and a scoped, revocable grant, so it can work unsupervised. The v1.1 experiment shows both side by side. See [poppy-vs-webmcp.md](poppy-vs-webmcp.md).

**Q: Why NRL tipping?**
A: It has public data (fixtures, ladder), personal read data (my tips), a low-risk write (submit a tip) and a natural custom scope (ladder standings). That covers every access level Poppy defines, with no money or real personal data at stake.

**Q: What comes after v1?**
A: v1.1 was approved on 12 October 2026 and is planned in detail in TODO.md, Phases 6–10:
1. Move to AWS Lambda and DynamoDB, so the demo is always on.
2. The conversation API with a Claude-backed company agent, SSE streaming, human handoff and direct conversations.
3. An MCP server with resource-bound Bearer tokens.
4. A second company ("Footy Stats Co"), to show one agent working with many companies.
5. A one-day, side-by-side evaluation of PACT.
6. A WebMCP experiment: the same tip submitted by an in-browser agent and by a Poppy agent, to show the identity difference ([poppy-vs-webmcp.md](poppy-vs-webmcp.md)).

All the LLM work uses LangGraph (TS) on Claude.
