# Human TODO: actions only Tim can do

*Created 12 October 2026 · Companion to [TODO.md](TODO.md). Each item says what it unblocks. Claude can't do these items, because they need your accounts, your judgement, a physical device, or an outward-facing action that needs your approval.*

When an item is done, tick it and add the date. If it changes the plan, add a line to the decisions log in TODO.md.

## Before any code (Checkpoint 0)

| ✓ | Action | Unblocks | How / notes |
|---|---|---|---|
| [x] | Decide on version control: `git init` here, and whether to push to a GitHub remote (private or public) | Task 1 | **Done 12 Oct 2026:** private repo https://github.com/timothyohare/personal-agent-protocol, branch `main`. `.gitignore` excludes keys, vaults, `.env*` and `spikes/`. |
| [ ] | Install Node 22 LTS and npm | Task 1 | `node --version` should print v22.x |
| [ ] | Install Docker (for DynamoDB Local, used from Task 13) | Task 13 | Needed by `gate-verify` once `mockAws: dynamodb-local` is set |
| [ ] | **Spike S3:** run the callback redirect test page in Chrome, Firefox and Safari | Task 8 | Claude builds the test page, and you click through it in each browser and report what happens. Safari needs a Mac or iPhone. If you don't have one, say so and the spike records Safari as untested. |
| [ ] | Review the spike notes for S3, S4 and S5 in `docs/spikes/` | Checkpoint 0 | Approve any plan changes the spikes recommend |

## v1 (Tasks 1–12)

| ✓ | Action | Unblocks | How / notes |
|---|---|---|---|
| [ ] | Review the `poppy-core` API | Checkpoint A | Read `packages/poppy-core/src/*.ts` and the mutation-testing report |
| [ ] | Check a secret store is available for the agent's vault (Linux: GNOME Keyring or KWallet via libsecret) | Task 8 | If neither is available, approve the fallback: a key file with 0600 permissions |
| [ ] | **Manual sign-in in a real browser** (HowToVerify M3) | Checkpoint C | Includes checking the consent page shows the agent's host as well as its name (SecurityReview T-11) |
| [ ] | **Security sign-off** (SecurityReview section 7) | Checkpoint D | The v1 sign-off is yours. Claude provides the evidence. |
| [ ] | Create an Anthropic API key for the demo, with a spend limit set in the console | Spike S6, Task 12 | Store it in your shell's secret manager or `.env.local` (git-ignored). Never paste it into chat. |
| [ ] | **Spike S6** review: approve LangGraph, or switch to the Claude Agent SDK fallback | Task 12 | |
| [ ] | Run the live LLM demo (HowToVerify M6) and confirm it asks before submitting a tip | Checkpoint E | |
| [ ] | Rehearse the full demo from a cold start (target: under 10 minutes) | Checkpoint E | PRD success metric |
| [ ] | Review checkpoints A–E | Each phase | Claude pastes the gate output, and you approve moving on |

## v1.1 cloud setup (before Task 14)

| ✓ | Action | Unblocks | How / notes |
|---|---|---|---|
| [ ] | Choose the AWS account and region for the demo, and set up CLI access (`aws configure sso` or a named profile) | S1, S2, S9, Task 14 | Prefer a separate sandbox account. CloudFront certificates must be in us-east-1, but the app can run in any region (for example ap-southeast-2). |
| [ ] | Install AWS CLI v2 and AWS SAM CLI | Task 14 | `sam --version` |
| [ ] | Create an **AWS budget alarm** (for example AUD 20 a month) and confirm the email subscription | Task 14 | Covers Lambda, CloudFront, DynamoDB and runaway LLM-driven traffic |
| [ ] | **Spike S9: DNS for `ohare.id.au`.** Decide where its DNS lives (Route 53 hosted zone, or your current provider). Add the ACM validation records. | Task 14 | Subdomains: `tipping`, `agent`, and later `stats`. Changing nameservers is your call, because it affects everything else on the domain. |
| [ ] | Approve the first `sam deploy` | Task 14 | It's outward-facing, because it creates public URLs. Claude will ask before every deploy. |
| [ ] | Put the Anthropic API key in AWS Secrets Manager (for the company agent) | Task 16 | Use a separate key from your local one, so you can revoke it independently |
| [ ] | Review the spike notes for S1, S2 and S9, and choose a fallback if S1 fails | Checkpoint F | S1 is the most likely to change the plan (CloudFront vs the `Authorization` header) |

## v1.1 features (Tasks 15–23)

| ✓ | Action | Unblocks | How / notes |
|---|---|---|---|
| [ ] | Choose the operator-console password, and store it in Secrets Manager yourself | Task 18 | Claude creates the empty secret, and you set the value so it never passes through chat |
| [ ] | **Play the human operator** in the handoff test (HowToVerify M8) | Checkpoint G | Join a queued conversation, reply, and ask to talk to the customer directly |
| [ ] | **Act as the user** in a direct conversation (M8 step 4) | Checkpoint G | Your typed words should be sent as `sender: human` |
| [ ] | Run the MCP and two-company chat checks (M9, M10) | Checkpoints H, I | |
| [ ] | Approve cloning the PACT repository into `~/dev/newdev/pact-eval/` | Spike S11, Task 22 | It's third-party code, so it's run outside this repo |
| [ ] | Review `docs/PACT-comparison.md` (M11) | Checkpoint J | |
| [ ] | **Spike S10 (WebMCP):** install Chrome 149, enable the WebMCP flag, and install whichever agent or inspector extension the spike identifies | Task 23 | Needs your browser profile |
| [ ] | Register `https://tipping.ohare.id.au` for the **Chrome WebMCP origin trial** and paste the token into the deployment config | Task 23 (cloud run) | Register at the Chrome Origin Trials site with your Google account. The token is public (it goes in a page header), so it isn't a secret. |
| [ ] | Run the WebMCP vs Poppy side-by-side test (M12) and check the observations Claude appends to `poppy-vs-webmcp.md` | Checkpoint K | |
| [ ] | Review checkpoints F–K | Each phase | |

## Ongoing

| ✓ | Action | Notes |
|---|---|---|
| [ ] | Check the Poppy spec for new drafts (personalagentprotocol.org) about every two weeks | Draft 0.1 allows breaking changes. Tell Claude when it changes, so the briefing and S4 checklist can be updated. |
| [ ] | Approve or reject each spike's fallback when a spike fails | Recorded in the TODO.md decisions log |
| [ ] | Tear down the AWS stack (`sam delete`) when the demo is no longer needed | Avoids ongoing cost and an abandoned public endpoint |
