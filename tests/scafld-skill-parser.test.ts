import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  validateRunnerManifestYaml,
  validateSkillMarkdown,
} from "../scripts/lib/native-parser.mjs";

const execFile = promisify(execFileCallback);
const scafldStageDir = path.resolve("skills/issue-to-pr/graph/scafld");

describe("scafld graph stage contract", () => {
  it("keeps the portable stage standard while X stays a thin native scafld consumer", async () => {
    const skillPath = path.join(scafldStageDir, "SKILL.md");
    const wrapperPath = path.join(scafldStageDir, "tools", "scafld-cli.mjs");
    const skill = validateSkillMarkdown(await readFile(skillPath, "utf8"));
    const manifest = validateRunnerManifestYaml(await readFile(path.join(scafldStageDir, "X.yaml"), "utf8"));
    const wrapper = await readFile(wrapperPath, "utf8");
    const runner = manifest.runners["scafld-cli"];
    const agentRunner = manifest.runners.agent;

    expect(skill.name).toBe("scafld");
    expect(skill.source.type).toBe("agent");
    expect(skill.inputs).toEqual({});
    expect(runner?.default).toBe(true);
    expect(runner?.source.type).toBe("cli-tool");
    expect(runner?.source.command).toBe("node");
    expect(runner?.source.args).toEqual(["./tools/scafld-cli.mjs"]);
    expect(wrapper).toContain("const result = spawnSync(scafld, args");
    expect(wrapper).toContain('args.push("--json")');
    expect(wrapper).toContain("const command = String(inputs.command || \"\");");
    expect(wrapper).toContain('"plan"');
    expect(wrapper).toContain('"harden"');
    expect(wrapper).toContain('"build"');
    expect(wrapper).toContain('"build_to_review"');
    expect(wrapper).toContain('"handoff"');
    expect(wrapper).toContain("scafld_min_version");
    expect(wrapper).toContain("ensureScafldVersion");
    expect(wrapper).toContain("function runBuildToReview");
    expect(wrapper).not.toContain('"new"');
    expect(wrapper).not.toContain('"branch"');
    expect(wrapper).not.toContain('"checks"');
    expect(wrapper).not.toContain('"pr-body"');
    expect(wrapper).not.toContain("normalizeStructuredOutput");
    expect(wrapper).not.toContain("buildStatusReport");
    expect(wrapper).not.toContain("buildReviewReport");
    expect(wrapper).not.toContain("buildCompleteReport");
    expect(wrapper).not.toContain("env: process.env");
    expect(runner?.source.timeoutSeconds).toBe(300);
    expect(agentRunner).toBeUndefined();
    expect(runner?.inputs.command.required).toBe(true);
    expect(runner?.inputs.task_id.required).toBe(false);
    expect(runner?.inputs.acceptance_command.required).toBe(false);
    expect(runner?.inputs.provider.required).toBe(false);
    expect(runner?.inputs.mark_passed.required).toBe(false);
    expect(runner?.inputs.max_builds.required).toBe(false);
    expect(runner?.runtime).toEqual({
      requirements: [
        "scafld CLI 2.4.0 or newer with native JSON contracts available on PATH, via SCAFLD_BIN, or through explicit scafld_bin input",
      ],
    });
  });

  it("recovers successful command-review results from status when review omits JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-scafld-review-status-"));
    const fakeScafld = path.join(tempDir, "fake-scafld.mjs");
    const wrapperPath = path.join(scafldStageDir, "tools", "scafld-cli.mjs");

    try {
      await writeFile(
        fakeScafld,
        `#!/usr/bin/env node
const argv = process.argv.slice(2);
const command = argv[0] || "";
if (command === "--version") {
  process.stdout.write("2.4.0\\n");
  process.exit(0);
}
if (command === "review") {
  process.stderr.write("scafld review[command] started node reviewer.mjs\\n");
  process.stderr.write("scafld review[command] completed exit=0 elapsed=4ms last_output=0s\\n");
  process.exit(0);
}
if (command === "status") {
  process.stdout.write(JSON.stringify({
    ok: true,
    command: "status",
    result: {
      task_id: argv[1],
      status: "review",
      review: {
        verdict: "pass",
        findings: [],
      },
    },
  }) + "\\n");
  process.exit(0);
}
process.stderr.write(\`unsupported command: \${command}\\n\`);
process.exit(1);
`,
        { mode: 0o755 },
      );

      const { stdout } = await execFile("node", [wrapperPath], {
        cwd: tempDir,
        env: {
          ...process.env,
          RUNX_INPUTS_JSON: JSON.stringify({
            command: "review",
            task_id: "fixture-task",
            fixture: tempDir,
            scafld_bin: fakeScafld,
          }),
        },
      });

      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        command: "review",
        result: {
          task_id: "fixture-task",
          status: "review",
          verdict: "pass",
          findings: [],
          review: {
            verdict: "pass",
            findings: [],
          },
          recovered_from_status: true,
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the resolved scafld is older than 2.4.0", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-scafld-old-version-"));
    const fakeScafld = path.join(tempDir, "fake-scafld.mjs");
    const wrapperPath = path.join(scafldStageDir, "tools", "scafld-cli.mjs");

    try {
      await writeFile(
        fakeScafld,
        `#!/usr/bin/env node
const argv = process.argv.slice(2);
const command = argv[0] || "";
if (command === "--version") {
  process.stdout.write("2.3.12\\n");
  process.exit(0);
}
if (command === "validate") {
  process.stdout.write(JSON.stringify({
    ok: true,
    command: "validate",
    result: { task_id: argv[1], valid: true, errors: null },
  }) + "\\n");
  process.exit(0);
}
process.stderr.write(\`unsupported command: \${command}\\n\`);
process.exit(1);
`,
        { mode: 0o755 },
      );

      await expect(execFile("node", [wrapperPath], {
        cwd: tempDir,
        env: {
          ...process.env,
          RUNX_INPUTS_JSON: JSON.stringify({
            command: "validate",
            task_id: "fixture-task",
            fixture: tempDir,
            scafld_bin: fakeScafld,
          }),
        },
      })).rejects.toMatchObject({
        stderr: expect.stringContaining("scafld 2.4.0 or newer is required"),
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
