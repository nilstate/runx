import { defineConfig } from "vitest/config";

import { workspaceAliases } from "./vitest.workspace-aliases.js";

export default defineConfig({
  resolve: {
    alias: [...workspaceAliases],
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "tests/kernel-parity-fixtures.test.ts",
      "tests/payment-finality-adapters.test.ts",
      "tests/stripe-spt-rail-adapter.test.ts",
    ],
    // These suites shell out to the debug `runx` binary; the generous timeouts
    // absorb its cold start under parallel load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
