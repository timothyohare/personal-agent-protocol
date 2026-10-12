# Spike S3: browser callback reaching the CLI

*Started 12 October 2026 · **Status: waiting for Tim's browser runs** · Code: `spikes/S3-callback/` (git-ignored). Test pages: https://timothyohare.github.io/personal-agent-protocol/s3/ (the `gh-pages` branch; remove after the spike).*

## Question

After sign-in, can a page on a **public HTTPS origin** (standing in for `https://agent.ohare.id.au/oauth/callback`) send the browser on to `http://127.0.0.1:<port>`, where the CLI waits, in current Chrome, Firefox and Safari, without a warning? Browsers are tightening the rules on public pages reaching local addresses (Chrome's Local Network Access).

## Set-up

| Piece | Plays | Where |
|---|---|---|
| `index.html` | The company's authorization server, redirecting to the callback with a test `code`, `state` and `iss` | GitHub Pages (public HTTPS) |
| `callback.html` | The agent host's `/oauth/callback` page, which forwards to the CLI | GitHub Pages (public HTTPS) |
| `listener.mjs` | The CLI's loopback listener on `127.0.0.1:8799`, which records each hit in `results.jsonl` | Tim's machine |

The callback page only forwards to `127.0.0.1` on a port taken from `state` (`<nonce>.<port>`, port 1024–65535). It refuses any other input, so it can't be used as an open redirect. Only test values are used.

**Variants tested:**
1. `js-replace`: `location.replace()`, the planned design
2. `meta-refresh`: a meta refresh tag
3. `form-post`: an auto-submitted POST form, which keeps the code out of the loopback URL and browser history
4. `manual-click`: the user clicks a link, as the fallback

## Local check (done)

Served from `localhost` and checked with headless Google Chrome 126.0.6478.182 (`--headless=new`). All three automatic variants reached the listener (GET, GET, POST), and a tampered `state` (`evil.example.com`) was refused with "Bad or missing state. Not forwarding." This proves the kit works. It does **not** answer the question, because `localhost` to `127.0.0.1` is never restricted.

## How to run (Tim)

**First, update Chrome.** This machine has Chrome **126** (mid-2024). The local-network restrictions this spike is testing arrived in much later versions, and current stable is around 149. A run on 126 would give a false pass. Check the version at `chrome://version`, and record the exact versions of all three browsers in the results table.

```bash
node spikes/S3-callback/listener.mjs https://timothyohare.github.io/personal-agent-protocol/s3/
```

1. Open the URL the listener prints in **Chrome**, then **Firefox**, then **Safari** if you have a Mac or iPhone. (For an iPhone, the listener would need to be on the phone's own loopback, so Safari on a Mac is the realistic option.)
2. Click each of the 4 links. For each one, note what the browser does: a smooth redirect, a permission prompt, a warning page, an error, or nothing.
3. Stop the listener with Ctrl+C. Claude reads `spikes/S3-callback/results.jsonl` and fills in the table below.

## Results

| Browser and version | js-replace | meta-refresh | form-post | manual-click | Notes |
|---|---|---|---|---|---|
| Chrome | | | | | |
| Firefox | | | | | |
| Safari | | | | | |

## Answer

*Pending.*

## Pass, fallback and clean-up

- **Pass:** `js-replace`, or `form-post`, works in Chrome, Firefox and Safari without a warning or prompt.
- **Fallback, if a browser prompts or blocks:**
  1. Register a loopback redirect URI directly, in the style of RFC 8252, if Poppy and the company allow it. (Spec 4.1 requires `redirect_uris` to be HTTPS on the agent's domain, so this probably needs a spec change.)
  2. Otherwise, the CLI polls the agent host for the code.
  3. Otherwise, manual paste.
- **Clean-up after the spike:** delete the `gh-pages` branch (`git push origin --delete gh-pages`), which unpublishes the pages.
