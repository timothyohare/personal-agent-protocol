import { defineConfig } from "vitest/config";

const pkg = (name: string) => ({ test: { name, include: [`packages/${name}/test/**/*.test.ts`] } });

export default defineConfig({
  test: {
    // The machine has run out of memory before; keep the worker count low.
    pool: "forks",
    maxWorkers: 2,
    projects: [pkg("poppy-core"), pkg("company"), pkg("agent-host"), pkg("agent")],
  },
});
