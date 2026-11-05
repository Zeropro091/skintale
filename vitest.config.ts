import { defineConfig } from "vitest/config";

// Unique per run so a crashed run can never poison the next one, and no other
// process (e.g. a dev server) can hold a lock on the test database.
const testDbPath = `data/test-${Date.now()}.db`;

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30000,
    // Injected BEFORE any module evaluation. config.ts and db/index.ts read these at
    // import time, so they must not be set inside beforeAll — too late by then.
    env: {
      NODE_ENV: "test",
      VISION_PROVIDER: "stub",
      DB_PATH: testDbPath,
    },
  },
  // Safety net: some toolchains rewrite `node:sqlite` to the bare specifier.
  resolve: {
    alias: [{ find: /^sqlite$/, replacement: "node:sqlite" }],
  },
});
