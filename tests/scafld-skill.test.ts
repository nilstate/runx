import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("scafld skill wrapper", () => {
  it("sanitizes runx input env and forwards native validate JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-scafld-skill-"));
    const fakeScafld = path.join(tempDir, "fake-scafld.mjs");
    const tracePath = path.join(tempDir, "validate-trace.json");

    try {
      await writeFile(
        fakeScafld,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
writeFileSync(process.env.FAKE_SCAFLD_TRACE, JSON.stringify({
  argv,
  leakedEnv: Object.keys(process.env)
    .filter((key) => key === "RUNX_INPUTS_JSON" || key.startsWith("RUNX_INPUT_"))
    .sort(),
}));
if (argv[0] === "validate") {
  process.stdout.write(JSON.stringify({
    ok: true,
    command: "validate",
    task_id: "fixture-task",
    warnings: [],
    state: { status: "draft" },
    result: { valid: true, file: ".ai/specs/drafts/fixture-task.yaml", errors: [] },
    error: null,
  }) + "\\n");
  process.exit(0);
}
process.stderr.write(\`unsupported command: \${argv[0] || ""}\\n\`);
process.exit(1);
`,
        { mode: 0o755 },
      );

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/scafld"),
        runner: "scafld-cli",
        inputs: {
          command: "validate",
          task_id: "fixture-task",
          fixture: tempDir,
          scafld_bin: fakeScafld,
        },
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: {
          ...process.env,
          FAKE_SCAFLD_TRACE: tracePath,
          RUNX_INPUTS_JSON: '{"secret":"do-not-forward"}',
          RUNX_INPUT_SECRET: "do-not-forward",
        },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(JSON.parse(result.execution.stdout)).toEqual({
        ok: true,
        command: "validate",
        task_id: "fixture-task",
        warnings: [],
        state: { status: "draft" },
        result: { valid: true, file: ".ai/specs/drafts/fixture-task.yaml", errors: [] },
        error: null,
      });
      expect(JSON.parse(await readFile(tracePath, "utf8"))).toEqual({
        argv: ["validate", "fixture-task", "--json"],
        leakedEnv: [],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("forwards native review and complete payloads without local reconstruction", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-scafld-native-"));
    const fakeScafld = path.join(tempDir, "fake-scafld.mjs");
    const reviewTracePath = path.join(tempDir, "review-trace.json");
    const completeTracePath = path.join(tempDir, "complete-trace.json");

    try {
      await writeFile(
        fakeScafld,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const command = argv[0] || "";
const tracePath = command === "review" ? process.env.FAKE_SCAFLD_REVIEW_TRACE : process.env.FAKE_SCAFLD_COMPLETE_TRACE;
writeFileSync(tracePath, JSON.stringify({
  argv,
  leakedEnv: Object.keys(process.env)
    .filter((key) => key === "RUNX_INPUTS_JSON" || key.startsWith("RUNX_INPUT_"))
    .sort(),
}));
if (command === "review") {
  process.stdout.write(JSON.stringify({
    ok: true,
    command: "review",
    task_id: "fixture-task",
    warnings: [],
    state: { status: "in_progress" },
    result: {
      review_file: ".ai/reviews/fixture-task.md",
      review_round: 1,
      automated_passes: [],
      required_sections: ["Regression Hunt", "Convention Check", "Dark Patterns"],
      review_prompt: "ADVERSARIAL REVIEW\\n\\nReview the bounded change set.",
    },
    error: null,
  }) + "\\n");
  process.exit(0);
}
if (command === "complete") {
  process.stdout.write(JSON.stringify({
    ok: true,
    command: "complete",
    task_id: "fixture-task",
    warnings: [],
    state: { status: "completed", review_verdict: "pass_with_issues" },
    result: {
      archive_path: ".ai/specs/archive/2026-04/fixture-task.yaml",
      blocking_count: 0,
      non_blocking_count: 1,
      pass_results: { spec_compliance: "pass" },
      override_applied: false,
      review_round: 1,
      review_file: ".ai/reviews/fixture-task.md",
      transition: { status: "completed" },
    },
    error: null,
  }) + "\\n");
  process.exit(0);
}
process.stderr.write(\`unsupported command: \${command}\\n\`);
process.exit(1);
`,
        { mode: 0o755 },
      );

      const reviewResult = await runLocalSkill({
        skillPath: path.resolve("skills/scafld"),
        runner: "scafld-cli",
        inputs: {
          command: "review",
          task_id: "fixture-task",
          fixture: tempDir,
          scafld_bin: fakeScafld,
        },
        caller,
        receiptDir: path.join(tempDir, "receipts-review"),
        runxHome: path.join(tempDir, "home-review"),
        env: {
          ...process.env,
          FAKE_SCAFLD_REVIEW_TRACE: reviewTracePath,
        },
      });

      expect(reviewResult.status).toBe("success");
      if (reviewResult.status !== "success") {
        return;
      }
      expect(JSON.parse(reviewResult.execution.stdout)).toEqual({
        ok: true,
        command: "review",
        task_id: "fixture-task",
        warnings: [],
        state: { status: "in_progress" },
        result: {
          review_file: ".ai/reviews/fixture-task.md",
          review_round: 1,
          automated_passes: [],
          required_sections: ["Regression Hunt", "Convention Check", "Dark Patterns"],
          review_prompt: "ADVERSARIAL REVIEW\n\nReview the bounded change set.",
        },
        error: null,
      });
      expect(JSON.parse(await readFile(reviewTracePath, "utf8"))).toEqual({
        argv: ["review", "fixture-task", "--json"],
        leakedEnv: [],
      });

      const completeResult = await runLocalSkill({
        skillPath: path.resolve("skills/scafld"),
        runner: "scafld-cli",
        inputs: {
          command: "complete",
          task_id: "fixture-task",
          fixture: tempDir,
          scafld_bin: fakeScafld,
        },
        caller,
        receiptDir: path.join(tempDir, "receipts-complete"),
        runxHome: path.join(tempDir, "home-complete"),
        env: {
          ...process.env,
          FAKE_SCAFLD_COMPLETE_TRACE: completeTracePath,
        },
      });

      expect(completeResult.status).toBe("success");
      if (completeResult.status !== "success") {
        return;
      }
      expect(JSON.parse(completeResult.execution.stdout)).toEqual({
        ok: true,
        command: "complete",
        task_id: "fixture-task",
        warnings: [],
        state: { status: "completed", review_verdict: "pass_with_issues" },
        result: {
          archive_path: ".ai/specs/archive/2026-04/fixture-task.yaml",
          blocking_count: 0,
          non_blocking_count: 1,
          pass_results: { spec_compliance: "pass" },
          override_applied: false,
          review_round: 1,
          review_file: ".ai/reviews/fixture-task.md",
          transition: { status: "completed" },
        },
        error: null,
      });
      expect(JSON.parse(await readFile(completeTracePath, "utf8"))).toEqual({
        argv: ["complete", "fixture-task", "--json"],
        leakedEnv: [],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves native non-zero failures instead of normalizing them away", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-scafld-failure-"));
    const fakeScafld = path.join(tempDir, "fake-scafld.mjs");

    try {
      await writeFile(
        fakeScafld,
        `#!/usr/bin/env node
const argv = process.argv.slice(2);
if ((argv[0] || "") === "checks") {
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

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/scafld"),
        runner: "scafld-cli",
        inputs: {
          command: "checks",
          task_id: "fixture-task",
          fixture: tempDir,
          scafld_bin: fakeScafld,
        },
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("failure");
      if (result.status !== "failure") {
        return;
      }
      expect(JSON.parse(result.execution.stdout)).toEqual({
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
      });
      expect(result.execution.exitCode).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
