import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultSkillAdapters } from "@runxhq/adapters";
import { runLocalSkill, type Caller } from "@runxhq/runtime-local";

const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("scafld skill wrapper", () => {
  it("sanitizes runx input env and forwards native validate JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-scafld-skill-"));
    const fakeScafld = path.join(tempDir, "fake-scafld.mjs");
    // Derived from the stub's own location so it survives the sandbox
    // env-allowlist (which strips test-only env vars before subprocess
    // invocation).
    const tracePath = path.join(tempDir, "validate-trace.json");

    try {
      await writeFile(
        fakeScafld,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("2.4.0\\n");
  process.exit(0);
}
writeFileSync(join(__dirname, \`\${argv[0] || "unknown"}-trace.json\`), JSON.stringify({
  argv,
  leakedEnv: Object.keys(process.env)
    .filter((key) => key === "RUNX_INPUTS_JSON" || key.startsWith("RUNX_INPUT_"))
    .sort(),
}));
if (argv[0] === "validate") {
  process.stdout.write(JSON.stringify({
    ok: true,
    command: "validate",
    result: { task_id: "fixture-task", valid: true, errors: null },
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
        adapters: createDefaultSkillAdapters(),
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
        ok: true,
        command: "validate",
        result: { task_id: "fixture-task", valid: true, errors: null },
      });
      expect(JSON.parse(await readFile(tracePath, "utf8"))).toEqual({
        argv: ["validate", "fixture-task", "--json"],
        leakedEnv: [],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the resolved scafld is older than 2.4.0", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-scafld-old-version-"));
    const fakeScafld = path.join(tempDir, "fake-scafld.mjs");

    try {
      await writeFile(
        fakeScafld,
        `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("2.3.12\\n");
  process.exit(0);
}
if ((argv[0] || "") === "validate") {
  process.stdout.write(JSON.stringify({
    ok: true,
    command: "validate",
    result: { task_id: "fixture-task", valid: true, errors: null },
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
        adapters: createDefaultSkillAdapters(),
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("failure");
      if (result.status !== "failure") {
        return;
      }
      expect(result.execution.stderr).toContain("scafld 2.4.0 or newer is required");
      expect(result.execution.stderr).toContain("2.3.12");
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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0] || "";
if (command === "--version") {
  process.stdout.write("2.4.0\\n");
  process.exit(0);
}
const tracePath = join(__dirname, \`\${command}-trace.json\`);
writeFileSync(tracePath, JSON.stringify({
  argv,
  leakedEnv: Object.keys(process.env)
    .filter((key) => key === "RUNX_INPUTS_JSON" || key.startsWith("RUNX_INPUT_"))
    .sort(),
}));
if (command === "review") {
  process.stdout.write("scafld review[command] started node reviewer.mjs\\n");
  process.stdout.write("scafld review[command] completed exit=0 elapsed=4ms last_output=0s\\n");
  process.stdout.write(JSON.stringify({
    ok: true,
    command: "review",
    result: {
      task_id: "fixture-task",
      status: "review",
      verdict: "pass",
      findings: [],
    },
  }) + "\\n");
  process.exit(0);
}
if (command === "complete") {
  process.stdout.write(JSON.stringify({
    ok: true,
    command: "complete",
    result: {
      task_id: "fixture-task",
      status: "completed",
      path: ".scafld/specs/archive/2026-05/fixture-task.md",
    },
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
        adapters: createDefaultSkillAdapters(),
        receiptDir: path.join(tempDir, "receipts-review"),
        runxHome: path.join(tempDir, "home-review"),
        env: process.env,
      });

      expect(reviewResult.status).toBe("success");
      if (reviewResult.status !== "success") {
        return;
      }
      expect(JSON.parse(reviewResult.execution.stdout)).toEqual({
        ok: true,
        command: "review",
        result: {
          task_id: "fixture-task",
          status: "review",
          verdict: "pass",
          findings: [],
        },
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
        adapters: createDefaultSkillAdapters(),
        receiptDir: path.join(tempDir, "receipts-complete"),
        runxHome: path.join(tempDir, "home-complete"),
        env: process.env,
      });

      expect(completeResult.status).toBe("success");
      if (completeResult.status !== "success") {
        return;
      }
      expect(JSON.parse(completeResult.execution.stdout)).toEqual({
        ok: true,
        command: "complete",
        result: {
          task_id: "fixture-task",
          status: "completed",
          path: ".scafld/specs/archive/2026-05/fixture-task.md",
        },
      });
      expect(JSON.parse(await readFile(completeTracePath, "utf8"))).toEqual({
        argv: ["complete", "fixture-task", "--json"],
        leakedEnv: [],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves relative scafld_bin paths from the scafld skill directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-scafld-relative-"));
    const fixtureDir = path.join(tempDir, "fixtures");
    const fakeScafld = path.join(fixtureDir, "fake-scafld.mjs");

    try {
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(
        fakeScafld,
        `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("2.4.0\\n");
  process.exit(0);
}
if ((argv[0] || "") === "validate") {
  process.stdout.write(JSON.stringify({
    ok: true,
    command: "validate",
    result: { task_id: "fixture-task", valid: true, errors: null },
  }) + "\\n");
  process.exit(0);
}
process.stderr.write(\`unsupported command: \${argv[0] || ""}\\n\`);
process.exit(1);
`,
        { mode: 0o755 },
      );

      const relativeFakeScafld = path.relative(path.resolve("skills/scafld"), fakeScafld);
      const result = await runLocalSkill({
        skillPath: path.resolve("skills/scafld"),
        runner: "scafld-cli",
        inputs: {
          command: "validate",
          task_id: "fixture-task",
          fixture: tempDir,
          scafld_bin: relativeFakeScafld,
        },
        caller,
        adapters: createDefaultSkillAdapters(),
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(JSON.parse(result.execution.stdout)).toMatchObject({
        ok: true,
        command: "validate",
        result: { task_id: "fixture-task" },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loads spilled runx inputs from RUNX_INPUTS_PATH", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-scafld-input-path-"));
    const fakeScafld = path.join(tempDir, "fake-scafld.mjs");

    try {
      await writeFile(
        fakeScafld,
        `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("2.4.0\\n");
  process.exit(0);
}
if ((argv[0] || "") === "validate") {
  process.stdout.write(JSON.stringify({
    ok: true,
    command: "validate",
    result: { task_id: "fixture-task", valid: true, errors: null },
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
          large_context: "x".repeat(64 * 1024),
        },
        caller,
        adapters: createDefaultSkillAdapters(),
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(JSON.parse(result.execution.stdout)).toMatchObject({
        ok: true,
        command: "validate",
        result: { task_id: "fixture-task" },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("build_to_review advances native build until scafld reports review", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-scafld-build-to-review-"));
    const fakeScafld = path.join(tempDir, "fake-scafld.mjs");

    try {
      await writeFile(
        fakeScafld,
        `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const countPath = join(__dirname, "build-count.txt");
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("2.4.0\\n");
  process.exit(0);
}
if ((argv[0] || "") === "build") {
  const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
  writeFileSync(countPath, String(count));
  process.stdout.write(JSON.stringify({
    ok: true,
    command: "build",
    result: {
      task_id: argv[1],
      status: count === 1 ? "active" : "review",
      phase: count === 1 ? "phase1" : "final",
      passed: count === 1 ? 0 : 2,
      failed: 0,
      next: count === 1 ? "scafld build fixture-task" : "scafld review fixture-task",
    },
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
          command: "build_to_review",
          task_id: "fixture-task",
          fixture: tempDir,
          scafld_bin: fakeScafld,
        },
        caller,
        adapters: createDefaultSkillAdapters(),
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(JSON.parse(result.execution.stdout)).toEqual({
        ok: true,
        command: "build_to_review",
        result: {
          task_id: "fixture-task",
          status: "review",
          phase: "final",
          passed: 2,
          failed: 0,
          next: "scafld review fixture-task",
          iterations: 2,
          builds: [
            {
              task_id: "fixture-task",
              status: "active",
              phase: "phase1",
              passed: 0,
              failed: 0,
              next: "scafld build fixture-task",
            },
            {
              task_id: "fixture-task",
              status: "review",
              phase: "final",
              passed: 2,
              failed: 0,
              next: "scafld review fixture-task",
            },
          ],
          last: {
            task_id: "fixture-task",
            status: "review",
            phase: "final",
            passed: 2,
            failed: 0,
            next: "scafld review fixture-task",
          },
        },
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
if (argv[0] === "--version") {
  process.stdout.write("2.4.0\\n");
  process.exit(0);
}
if ((argv[0] || "") === "build") {
  process.stdout.write(JSON.stringify({
    ok: false,
    command: "build",
    error: {
      code: "acceptance_failed",
      message: "acceptance command failed",
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
          command: "build",
          task_id: "fixture-task",
          fixture: tempDir,
          scafld_bin: fakeScafld,
        },
        caller,
        adapters: createDefaultSkillAdapters(),
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
        command: "build",
        error: {
          code: "acceptance_failed",
          message: "acceptance command failed",
          exit_code: 1,
        },
      });
      expect(result.execution.exitCode).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
