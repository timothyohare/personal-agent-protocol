import { expect, test } from "vitest";
import { startLoopback } from "../src/index.ts";

test("receives a POSTed callback on 127.0.0.1 and then closes", async () => {
  const lb = await startLoopback();
  expect(lb.port).toBeGreaterThan(1023);
  const res = await fetch(`http://127.0.0.1:${lb.port}/cb`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: "code=c1&state=s1&iss=https%3A%2F%2Fx" });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const p = await lb.result;
  expect(Object.fromEntries(p)).toEqual({ code: "c1", state: "s1", iss: "https://x" });
  await expect(fetch(`http://127.0.0.1:${lb.port}/cb`)).rejects.toThrow();
});

test("a GET callback works, other paths are 404", async () => {
  const lb = await startLoopback();
  expect((await fetch(`http://127.0.0.1:${lb.port}/other`)).status).toBe(404);
  await fetch(`http://127.0.0.1:${lb.port}/cb?code=c2&state=s2`);
  expect((await lb.result).get("code")).toBe("c2");
});

test("times out", async () => {
  const lb = await startLoopback({ timeoutMs: 20 });
  await expect(lb.result).rejects.toThrow(/timed out/);
});
