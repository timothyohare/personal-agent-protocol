// Full Direct Sign-In in-process: the agent starts it, the test browser plays the user.
import type { CompanyClient } from "agent";
import { TestBrowser, userSignsIn, type SignInOptions } from "./browser.ts";

export const ALL_SCOPES = ["poppy:read", "poppy:write", "standings"];

export async function signInFlow(client: CompanyClient, fetch: typeof globalThis.fetch,
  o: SignInOptions & { scopes?: string[]; browser?: TestBrowser } = {}) {
  const url = await client.beginSignIn(o.scopes ?? ALL_SCOPES);
  const callback = await userSignsIn(o.browser ?? new TestBrowser(fetch), url, o);
  return { url, callback, session: await client.completeSignIn(callback) };
}
