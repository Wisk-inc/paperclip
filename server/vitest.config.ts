import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@paperclipai\/paperclip-runner$/,
        replacement: fileURLToPath(
          new URL("../packages/paperclip-runner/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Each server suite boots + tears down its own embedded Postgres in
    // beforeAll/afterAll. Under the loaded serial shard (maxWorkers=1) the
    // graceful shutdown can occasionally cross vitest's default 10s hookTimeout,
    // producing flaky "Hook timed out in 10000ms" afterAll failures on CI.
    // Route suites also load their very large route modules in a hook on
    // purpose, so the one-time transform is paid there rather than inside a
    // test (see testTimeout below). On a 4-core container with every core busy
    // that transform measured 26-30s for src/routes/issues.ts and
    // src/routes/agents.ts (2026-11), and hooks failed at the old 30s. 120s
    // gives that room and still ends a genuinely hung hook. teardownTimeout
    // stays at 30s: Postgres teardown is far below it.
    hookTimeout: 120000,
    teardownTimeout: 30000,
    // The route/authz suites import very large modules (for example
    // src/routes/issues.ts and its dependency graph). The first test in each
    // file pays the one-time transform cost inside its own timeout budget. On
    // the loaded serial shard (maxWorkers=1) that cost can cross vitest's
    // default 5s testTimeout and fail the first test, which also lets its
    // fire-and-forget wake leak into the next test. Give each test generous
    // headroom. 15s used to be far above the observed module-load cost, but
    // the graph has grown: on a 4-core cloud container the first test of a
    // route suite measured 12-16s of transform alone (2026-11), failing about
    // a dozen suites whose other tests take milliseconds. 30s restores the
    // margin, matches hookTimeout, and still catches a genuinely hung test
    // well inside the 20 minute job limit.
    testTimeout: 30000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
