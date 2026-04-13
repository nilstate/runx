import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("scafld skill wrapper", () => {
  it("sanitizes runx input env and requests structured JSON for review commands", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-scafld-skill-"));
    const fakeScafld = path.join(tempDir, "fake-scafld.mjs");

    try {
      await writeFile(
        fakeScafld,
        `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  leakedEnv: Object.keys(process.env).filter((key) => key === "RUNX_INPUTS_JSON" || key.startsWith("RUNX_INPUT_")).sort()
}));
`,
        { mode: 0o755 },
      );

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/scafld"),
        runner: "scafld-cli",
        inputs: {
          command: "review",
          task_id: "fixture-task",
          fixture: tempDir,
          scafld_bin: fakeScafld,
        },
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: {
          ...process.env,
          RUNX_INPUTS_JSON: '{"secret":"do-not-forward"}',
          RUNX_INPUT_SECRET: "do-not-forward",
        },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(JSON.parse(result.execution.stdout)).toEqual({
        argv: ["review", "fixture-task", "--json"],
        leakedEnv: [],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
