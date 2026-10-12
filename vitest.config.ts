import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url));
const pkg = (name: string) => ({ extends: true, test: { name, include: [`packages/${name}/test/**/*.test.ts`] } });

export default defineConfig({
  resolve: {
    // Resolve workspace packages to source next to this config, not through node_modules symlinks.
    // Stryker runs in a sandbox copy whose node_modules links back to the real repo; without these
    // aliases, tests would import the unmutated originals and every mutant would look "uncovered".
    alias: [
      { find: /^poppy-core$/, replacement: src("poppy-core/src/index.ts") },
      { find: /^company$/, replacement: src("company/src/index.ts") },
      { find: /^company\/server$/, replacement: src("company/src/server.ts") },
      { find: /^agent-host$/, replacement: src("agent-host/src/index.ts") },
      { find: /^agent-host\/server$/, replacement: src("agent-host/src/server.ts") },
      { find: /^agent$/, replacement: src("agent/src/index.ts") },
    ],
  },
  test: {
    // The machine has run out of memory before; keep the worker count low.
    pool: "forks",
    maxWorkers: 2,
    projects: [pkg("poppy-core"), pkg("company"), pkg("agent-host"), pkg("agent")],
  },
});
