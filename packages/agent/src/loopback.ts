// The CLI's loopback listener (RFC 8252 §7.3 style) that receives the sign-in callback,
// forwarded by the agent host's /oauth/callback page. Binds 127.0.0.1 only and accepts one callback.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font:16px system-ui,sans-serif;max-width:30rem;margin:3rem auto">
<h1>You can close this tab</h1><p>Your agent has the sign-in result.</p></body>`;

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) throw new Error("callback too large");
  }
  return body;
}

export interface Loopback {
  port: number;
  /** Resolves with the callback parameters (code, state, iss or error). */
  result: Promise<URLSearchParams>;
  close(): void;
}

export async function startLoopback(opts: { port?: number; timeoutMs?: number } = {}): Promise<Loopback> {
  let resolve!: (p: URLSearchParams) => void;
  let reject!: (e: Error) => void;
  const result = new Promise<URLSearchParams>((res, rej) => { resolve = res; reject = rej; });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/cb" || (req.method !== "GET" && req.method !== "POST")) {
      res.writeHead(404).end();
      return;
    }
    try {
      const params = req.method === "POST" ? new URLSearchParams(await readBody(req)) : url.searchParams;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "referrer-policy": "no-referrer" }).end(DONE_PAGE);
      resolve(params);
    } catch (e) {
      res.writeHead(400).end();
      reject(e as Error);
    }
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const timer = setTimeout(() => reject(new Error("timed out waiting for sign-in")), opts.timeoutMs ?? 5 * 60_000);
  const close = () => { clearTimeout(timer); server.close(); };
  result.finally(close).catch(() => {});
  return { port: (server.address() as AddressInfo).port, result, close };
}
