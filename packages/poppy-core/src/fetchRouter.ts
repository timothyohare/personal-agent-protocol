// Routes fetch() calls to in-process apps by host, so tests and the in-process demo run without sockets.
export type Handler = { fetch: (req: Request) => Response | Promise<Response> };

export function fetchRouter(hosts: Record<string, Handler>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const app = hosts[new URL(req.url).host];
    if (!app) throw new TypeError(`fetch failed: no route for ${req.url}`);
    return app.fetch(req);
  }) as typeof fetch;
}

/** A fake host serving fixed JSON bodies (or redirects) by path. */
export function staticHost(routes: Record<string, unknown | { redirect: string }>): Handler {
  return {
    fetch(req) {
      const r = routes[new URL(req.url).pathname];
      if (r === undefined) return new Response("not found", { status: 404 });
      if (typeof r === "object" && r !== null && "redirect" in r) {
        return new Response(null, { status: 302, headers: { location: (r as { redirect: string }).redirect } });
      }
      return Response.json(r);
    },
  };
}
