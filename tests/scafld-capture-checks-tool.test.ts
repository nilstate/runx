import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const toolPath = path.resolve("tools/scafld/capture_checks/run.mjs");

describe("scafld.capture_checks tool", () => {
  it("captures native failing checks payloads without failing the tool step", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-scafld-capture-checks-"));
    const fakeScafld = path.join(tempDir, "fake-scafld.mjs");

    try {
      await writeFile(
        fakeScafld,
        `#!/usr/bin/env node
const argv = process.argv.slice(2);
if ((argv[0] || "") === "checks") {
  process.stderr.write("captured native stderr\\n");
  process.stdout.write(JSON.stringify({
    ok: false,
    command: "checks",
    task_id: "fixture-task",
    warnings: [],
    state: { status: "in_progress", check_status: "failure" },
    result: {
      check: {
        status: "failure",
        summary: "workspace has uncommitted changes",
        details: ["sync: drift"],
      },
    },
    error: {
      code: "projection_check_failed",
      message: "workspace has uncommitted changes",
      details: ["sync: drift"],
      next_action: null,
      exit_code: 1,
    },
  }) + "\\n");
  process.exit(1);
}
process.stderr.write(\`unsupported command: \${argv[0] || ""}\\n\`);
process.exit(1);
`,
        { mode: 0o755 },
      );

      const result = spawnSync("node", [toolPath], {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNX_INPUTS_JSON: JSON.stringify({
            task_id: "fixture-task",
            fixture: tempDir,
            scafld_bin: fakeScafld,
          }),
        },
      });

      expect(result.status).toBe(0);
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || "tool failed");
      }

      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        command: "checks",
        task_id: "fixture-task",
        state: { status: "in_progress", check_status: "failure" },
        result: {
          check: {
            status: "failure",
            summary: "workspace has uncommitted changes",
            details: ["sync: drift"],
          },
        },
        error: {
          code: "projection_check_failed",
          message: "workspace has uncommitted changes",
          details: ["sync: drift"],
          next_action: null,
          exit_code: 1,
        },
        native_exit_code: 1,
        native_stderr: "captured native stderr\n",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
