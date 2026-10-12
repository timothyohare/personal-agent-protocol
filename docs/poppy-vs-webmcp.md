# Poppy vs WebMCP

*Addendum to the Personal Agent Protocol briefing · 12 October 2026*

**Which WebMCP:** the browser API proposed in the W3C Web Machine Learning Community Group, written by Microsoft and Google. A page registers tools with `document.modelContext.registerTool()`, or adds declarative attributes to its HTML forms. An agent running *inside the browser* discovers those tools and calls them. Each tool has a name, a description and an input schema, the same shape as MCP tools. (webmcp.dev is a different thing: an earlier community library of the same name that bridges a page to a desktop MCP client. The W3C work credits it as prior art.)

**Status (Oct 2026):**

- Chrome 149 origin trial; Edge 150 origin trial; experimental in Brave's Leo assistant.
- Firefox and Safari: standards-positions discussions only.
- OpenAI added support in the ChatGPT desktop app's built-in browser and ChatGPT Sites (Aug 2026).
- A Community Group draft, explicitly not on the W3C standards track. About 3.5k GitHub stars.
- So it's further along than Poppy on running code and agent support, but just as early as a standard.

## Same problem, opposite ends

| | WebMCP | Poppy |
|---|---|---|
| Where the tools run | Client-side JavaScript in the open page | The company's servers (OpenAPI, MCP, company agent) |
| Who the agent is | A browser-built-in agent, an extension, or an agent embedded in the page | Any personal agent, including server-hosted ones with no browser |
| How the user is authenticated | **It isn't, by WebMCP.** Tools run inside the user's existing logged-in browser session, cookies and origin. | Explicit OAuth sign-in, with the user approving scopes for that specific agent |
| Does the site know which agent is calling? | No. The browser mediates the call, and the site sees its own page code running. | Yes: `client_id` plus a key-bound token on every request |
| Permission model | The site decides which tools exist on each page and state. Within that, the agent has whatever the user's session has. A site can opt out with `Permissions-Policy: tools=()`. | Scopes granted per agent and per user, revocable from either side |
| Human in the loop | A core design assumption. Headless and fully autonomous use are explicit non-goals. User confirmation prompts are still an open issue. | Designed for the agent working while the user is away, and bringing the user in when needed |
| Discovery | Only once the page is loaded (service-worker discovery is proposed) | `/.well-known/poppy.json`, before any page load |
| Effort for a site | Low: wrap existing front-end functions | Higher: authorization server changes, a session model, APIs |
| Spectrum position | A structured version of "the agent acts as the user" | The middle steps: signed-out, then read, then write |

## What this means for identity

WebMCP sidesteps the identity problem. It assumes the agent sits in the user's own browser, already authenticated as the user, so there's no separate agent identity or delegated consent to manage. That's why it's simpler, and why it's limited to supervised, in-browser work.

Poppy tackles identity head-on, because its agents may run anywhere and act unsupervised.

## Using them together

Poppy's web-browsing section (spec section 5) lets a personal agent's browser join a Poppy session, and the company then applies the session's scopes on its own pages. A company could expose WebMCP tools on those pages, so a Poppy-identified agent gets structured tools, and the company enforces the Poppy scopes behind them.

## For banks

- A browser agent using WebMCP inside internet banking inherits the full customer session. That's effectively full access, with no way for the bank to tell whether the customer or the agent invoked an action.
- **Likely stance:** expose read-only or low-risk tools (find a statement, explain a transaction, start a dispute). Keep payments and payee changes off WebMCP or behind native confirmation, and use `Permissions-Policy: tools=()` on sensitive pages until confirmation prompts are standardised.
- WebMCP is a cheap, low-commitment way to make servicing journeys agent-friendly. Poppy (or the CDR) remains the route for unsupervised, delegated access.

## Build experiment

Add WebMCP to the Tipping Co pages (roughly 30 lines): tools such as `get-fixtures`, `get-my-tips` and `submit-tip` that reuse the page's existing fetch code. Test them in Chrome 149 with the origin trial token. Then compare:

- The WebMCP agent submits a tip as you, with no consent screen, and the server can't tell an agent did it.
- The Poppy agent has to be granted `poppy:write`, and every request names the agent.

That contrast is the clearest demonstration of the identity difference. The experiment is planned as Task 23 in [TODO.md](TODO.md), with checks in [HowToVerify.md](HowToVerify.md) (M12).

## Sources

- WebMCP explainer and implementation status: https://github.com/webmachinelearning/webmcp
- Chrome WebMCP origin trial: https://developer.chrome.com/blog/ai-webmcp-origin-trial
- ChatGPT desktop WebMCP support: https://gigazine.net/gsc_news/en/20260826-chatgpt-webmcp/
- webmcp.dev (community library, a precursor): https://webmcp.dev/
