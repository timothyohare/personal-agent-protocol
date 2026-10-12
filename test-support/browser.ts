// Plays the *user* in tests and the acceptance run: a tiny cookie-keeping browser that fills in
// the company's login and consent forms. This is test-harness code. The agent library must never
// do this (spec 4.4, S4 E4).

export interface FormPage {
  status: number;
  html: string;
  headers: Headers;
}

export class TestBrowser {
  private cookies = new Map<string, string>();
  private readonly fetch: typeof fetch;

  constructor(f: typeof fetch) {
    this.fetch = f;
  }

  private store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      this.cookies.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  }

  private cookieHeader(): Record<string, string> {
    return this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {};
  }

  clearCookies() { this.cookies.clear(); }

  async get(url: string): Promise<Response> {
    const res = await this.fetch(url, { redirect: "manual", headers: this.cookieHeader() });
    this.store(res);
    return res;
  }

  async post(url: string, fields: [string, string][]): Promise<Response> {
    const res = await this.fetch(url, { method: "POST", redirect: "manual", body: new URLSearchParams(fields),
      headers: { "content-type": "application/x-www-form-urlencoded", ...this.cookieHeader() } });
    this.store(res);
    return res;
  }
}

/** Hidden inputs, the form action and checkbox values from a page. */
export function parseForm(html: string) {
  const action = html.match(/<form[^>]*action="([^"]+)"/)?.[1];
  const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)]
    .map((m) => [m[1]!, m[2]!]));
  const checkboxes = [...html.matchAll(/<input type="checkbox" name="scope" value="([^"]+)"/g)].map((m) => m[1]!);
  return { action, hidden, checkboxes };
}

export interface SignInOptions {
  username?: string;
  password?: string;
  /** Scopes to untick on the consent page. */
  untick?: string[];
  decision?: "approve" | "deny";
}

/**
 * Opens the authorize URL, signs in and answers the consent page.
 * Returns the final redirect location (the agent's callback URL with code, state and iss).
 */
export async function userSignsIn(browser: TestBrowser, authorizeUrl: string, o: SignInOptions = {}): Promise<string> {
  const origin = new URL(authorizeUrl).origin;
  const start = await browser.get(authorizeUrl);
  if (start.status !== 200) throw new Error(`authorize returned ${start.status}: ${start.headers.get("location") ?? ""}`);
  const login = parseForm(await start.text());
  const afterLogin = await browser.post(new URL(login.action!, origin).toString(), [
    ["req", login.hidden.req!], ["csrf", login.hidden.csrf!],
    ["username", o.username ?? "tipper"], ["password", o.password ?? "correct horse battery staple"],
  ]);
  if (afterLogin.status !== 200) throw new Error(`login returned ${afterLogin.status}`);
  const consent = parseForm(await afterLogin.text());
  const scopes = consent.checkboxes.filter((s) => !(o.untick ?? []).includes(s));
  const done = await browser.post(new URL(consent.action!, origin).toString(), [
    ["req", consent.hidden.req!], ["csrf", consent.hidden.csrf!], ...scopes.map((s) => ["scope", s] as [string, string]),
    ["decision", o.decision ?? "approve"],
  ]);
  const loc = done.headers.get("location");
  if (done.status !== 303 || !loc) throw new Error(`consent returned ${done.status}`);
  return loc;
}
