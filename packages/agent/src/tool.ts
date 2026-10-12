// The poppy_call tool (briefing 9.7 milestone 6): the model asks for an API call; the tool handles
// discovery, Sessions, DPoP, retries and sign-in. Only the API status and body (or an error code)
// go back to the model: never a token, proof, key, code or session_id (F12, spec 4.8).
import { PoppyError } from "poppy-core";
import type { PoppyAgent } from "./agent.ts";

export interface PoppyCallInput {
  company: string;
  method: string;
  path: string;
  body?: unknown;
}

export const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const isWrite = (method: string): boolean => WRITE_METHODS.has(method.toUpperCase());

export interface ToolDeps {
  agent: PoppyAgent;
  /**
   * Runs Direct Sign-In for `company`: shows the user the URL and waits for them. The model can't
   * do this; it only learns whether the user signed in.
   */
  signIn: (company: string, scopes: string[]) => Promise<boolean>;
  /** Scopes to ask for when a call needs sign-in. */
  scopes?: string[];
}

/** Returns the JSON text the model sees. */
export async function poppyCall(input: PoppyCallInput, d: ToolDeps): Promise<string> {
  const method = input.method.toUpperCase();
  if (!/^\/[A-Za-z0-9/_\-.~%?=&]*$/.test(input.path)) {
    return JSON.stringify({ error: "invalid_path", detail: "path must be a relative URL path like /api/fixtures" });
  }
  try {
    const c = d.agent.company(input.company);
    let r = await c.call(method, input.path, input.body);
    if (r.error === "sign_in_required") {
      const ok = await d.signIn(input.company, d.scopes ?? (await c.discovered()).poppy.auth.direct?.scopes ?? []);
      if (!ok) return JSON.stringify({ status: 403, error: "sign_in_required", detail: "the user did not sign in" });
      r = await c.call(method, input.path, input.body);
    }
    if (r.error) {
      return JSON.stringify({ status: r.status, error: r.error, ...(r.requiredScope ? { required_scope: r.requiredScope } : {}) });
    }
    return JSON.stringify({ status: r.status, body: r.body });
  } catch (e) {
    // PoppyError messages carry codes and descriptions, never secrets.
    return JSON.stringify({ error: e instanceof PoppyError ? e.code : "tool_error",
      detail: e instanceof PoppyError ? e.detail : (e as Error).message });
  }
}
