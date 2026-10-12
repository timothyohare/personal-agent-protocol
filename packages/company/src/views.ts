// Server-rendered login, consent and error pages. Everything interpolated is escaped.

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const page = (title: string, company: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(company)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 30rem; margin: 3rem auto; padding: 0 1rem; color: #1b1b1b; background: #fff; }
  h1 { font-size: 1.4rem; } .agent { padding: .75rem 1rem; border: 1px solid #ccc; border-radius: .5rem; }
  .host { font-family: ui-monospace, monospace; font-weight: 700; } .error { color: #a40000; }
  label { display: block; margin: .5rem 0; } input[type=text], input[type=password] { width: 100%; padding: .4rem; }
  button { padding: .5rem 1rem; margin-right: .5rem; } .note { color: #555; font-size: .9rem; }
</style></head><body>
<p class="note">${esc(company)}</p>
${body}
</body></html>`;

export function loginPage(o: { company: string; clientName: string; clientHost: string; reqId: string; csrf: string;
  error?: string }): string {
  return page("Sign in", o.company, `<h1>Sign in to ${esc(o.company)}</h1>
<p>An agent called <strong>${esc(o.clientName)}</strong> from <span class="host">${esc(o.clientHost)}</span> is asking to use your account.</p>
${o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : ""}
<form method="post" action="/oauth/authorize/login">
  <input type="hidden" name="req" value="${esc(o.reqId)}"><input type="hidden" name="csrf" value="${esc(o.csrf)}">
  <label>Username <input type="text" name="username" autocomplete="username" required></label>
  <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in</button>
</form>`);
}

export function consentPage(o: { company: string; clientName: string; clientHost: string; reqId: string; csrf: string;
  scopes: { scope: string; description: string }[]; username: string }): string {
  const boxes = o.scopes.map((s) => `<label><input type="checkbox" name="scope" value="${esc(s.scope)}" checked>
    <strong>${esc(s.scope)}</strong>: ${esc(s.description)}</label>`).join("\n");
  return page("Allow access", o.company, `<h1>Allow this agent to use your account?</h1>
<div class="agent"><p><strong>${esc(o.clientName)}</strong> <span class="note">(name chosen by the agent)</span><br>
from <span class="host">${esc(o.clientHost)}</span></p></div>
<p>Signed in as <strong>${esc(o.username)}</strong>. Untick anything you don't want to allow.</p>
<form method="post" action="/oauth/authorize/consent">
  <input type="hidden" name="req" value="${esc(o.reqId)}"><input type="hidden" name="csrf" value="${esc(o.csrf)}">
  ${boxes}
  <button type="submit" name="decision" value="approve">Allow</button>
  <button type="submit" name="decision" value="deny">Don't allow</button>
</form>`);
}

export function errorPage(company: string, message: string): string {
  return page("Error", company, `<h1>Sign-in can't continue</h1><p class="error" role="alert">${esc(message)}</p>
<p class="note">You can close this window.</p>`);
}
