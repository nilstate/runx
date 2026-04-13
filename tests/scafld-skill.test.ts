import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("scafld skill wrapper", () => {
  it("sanitizes runx input env and normalizes validate without relying on --json", async () => {
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
if (argv.includes("--json")) {
  process.stderr.write("unexpected --json\\n");
  process.exit(2);
}
if (argv[0] === "validate") {
  process.stdout.write("spec valid\\n");
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
        task_id: "fixture-task",
        valid: true,
        status: undefined,
        file: null,
        errors: [],
      });
      expect(JSON.parse(await readFile(tracePath, "utf8"))).toEqual({
        argv: ["validate", "fixture-task"],
        leakedEnv: [],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("normalizes review and complete outputs when the installed scafld lacks --json", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-scafld-complete-"));
    const fakeScafld = path.join(tempDir, "fake-scafld.mjs");
    const reviewTracePath = path.join(tempDir, "review-trace.json");
    const completeTracePath = path.join(tempDir, "complete-trace.json");

    try {
      await mkdir(path.join(tempDir, ".ai", "reviews"), { recursive: true });
      await writeFile(
        path.join(tempDir, ".ai", "reviews", "fixture-task.md"),
        `# Review: fixture-task

### Blocking

None.

### Non-blocking

None.

### Verdict

pass
`,
      );

      await writeFile(
        fakeScafld,
        `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const command = argv[0] || "";
const tracePath = command === "review" ? process.env.FAKE_SCAFLD_REVIEW_TRACE : process.env.FAKE_SCAFLD_COMPLETE_TRACE;
writeFileSync(tracePath, JSON.stringify({
  argv,
  leakedEnv: Object.keys(process.env)
    .filter((key) => key === "RUNX_INPUTS_JSON" || key.startsWith("RUNX_INPUT_"))
    .sort(),
}));
if (argv.includes("--json")) {
  process.stderr.write("unexpected --json\\n");
  process.exit(2);
}
if (command === "review") {
  process.stdout.write("ADVERSARIAL REVIEW\\n\\nReview the bounded change set.\\n");
  process.exit(0);
}
if (command === "complete") {
  const archiveDir = join(process.cwd(), ".ai", "specs", "archive", "2026-04");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, "fixture-task.yaml"), "status: completed\\n");
  process.stdout.write("completed\\n");
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
        task_id: "fixture-task",
        status: "review_open",
        review_file: ".ai/reviews/fixture-task.md",
        review_prompt: "ADVERSARIAL REVIEW\n\nReview the bounded change set.",
        automated_passes: [],
        required_sections: ["regression_hunt", "convention_check", "dark_patterns"],
      });
      expect(JSON.parse(await readFile(reviewTracePath, "utf8"))).toEqual({
        argv: ["review", "fixture-task"],
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
        task_id: "fixture-task",
        completed_state: "completed",
        archive_path: ".ai/specs/archive/2026-04/fixture-task.yaml",
        review_file: ".ai/reviews/fixture-task.md",
        verdict: "pass",
        blocking_count: 0,
        non_blocking_count: 0,
      });
      expect(JSON.parse(await readFile(completeTracePath, "utf8"))).toEqual({
        argv: ["complete", "fixture-task"],
        leakedEnv: [],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
