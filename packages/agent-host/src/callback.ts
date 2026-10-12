// /oauth/callback (briefing 9.1): the page the company redirects the browser to after sign-in.
// It forwards code, state and iss to the CLI's loopback listener, whose port is carried in
// `state` as `<nonce>.<port>`. Anything else is refused, so the page can't be an open redirect.
import { randomBytes } from "node:crypto";
import { Hono } from "hono";

const STATE_RE = /^[A-Za-z0-9_-]{22,128}\.(\d{4,5})$/;
const FIELDS = ["code", "state", "iss", "error", "error_description"] as const;

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** The loopback port encoded in `state`, or undefined if `state` isn't in the expected form. */
export function loopbackPort(state: string | undefined): number | undefined {
  const m = state?.match(STATE_RE);
  const port = m ? Number(m[1]) : NaN;
  return port >= 1024 && port <= 65535 ? port : undefined;
}

const page = (body: string, nonce: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Returning to your agent</title>
<style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem}</style>
</head><body>${body}</body></html>`;

export function callbackRoutes(): Hono {
  const app = new Hono();
  app.get("/oauth/callback", (ctx) => {
    const q = ctx.req.query();
    const nonce = randomBytes(16).toString("base64");
    const headers = {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; `
        + "form-action http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
    };
    const port = loopbackPort(q.state);
    if (port === undefined) {
      return ctx.html(page("<h1>Sign-in can't be returned</h1><p>The request didn't come from a local agent. "
        + "Start sign-in again from your agent.</p>", nonce), 400, headers);
    }
    // POST keeps the code out of the loopback URL and the browser history (S3 variant form-post).
    const inputs = FIELDS.filter((f) => q[f] !== undefined)
      .map((f) => `<input type="hidden" name="${f}" value="${esc(q[f]!)}">`).join("");
    return ctx.html(page(`<h1>Returning to your agent…</h1>
<form id="f" method="post" action="http://127.0.0.1:${port}/cb">${inputs}
<noscript><p>Press the button to finish signing in.</p></noscript><button type="submit">Continue</button></form>
<script nonce="${nonce}">document.getElementById("f").submit();</script>`, nonce), 200, headers);
  });
  return app;
}
