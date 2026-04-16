import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseRunnerManifestYaml, validateRunnerManifest } from "../packages/parser/src/index.js";
import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

const scafldBin = process.env.SCAFLD_BIN ?? "/home/kam/dev/scafld/cli/scafld";
const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("issue-to-PR composite skill", () => {
  it("models authored spec, authored fix, and authored review as explicit boundaries around the scafld lifecycle", async () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(await readFile(path.resolve("skills/issue-to-pr/X.yaml"), "utf8")),
    );
    const runner = manifest.runners["issue-to-pr"];

    expect(runner?.source.type).toBe("chain");
    if (!runner || runner.source.type !== "chain" || !runner.source.chain) {
      throw new Error("issue-to-pr runner must declare an inline chain.");
    }
    const chain = runner.source.chain;

    expect(chain.steps.map((step) => step.id)).toEqual([
      "scafld-new",
      "author-spec",
      "write-spec",
      "read-spec",
      "scafld-validate",
      "scafld-approve",
      "scafld-start",
      "author-fix",
      "write-fix",
      "scafld-exec",
      "scafld-audit",
      "scafld-review-open",
      "reviewer-boundary",
      "write-review",
      "scafld-complete",
    ]);
    expect(chain.steps.find((step) => step.id === "write-spec")).toMatchObject({
      tool: "fs.write",
      context: {
        path: "author-spec.spec_draft.data.path",
        contents: "author-spec.spec_contents",
      },
    });
    expect(chain.steps.find((step) => step.id === "read-spec")).toMatchObject({
      tool: "fs.read",
      context: {
        path: "author-spec.spec_draft.data.path",
      },
    });
    expect(chain.steps.find((step) => step.id === "author-spec")).toMatchObject({
      context: {
        scafld_new_stdout: "scafld-new.stdout",
      },
    });
    expect(runner.inputs.repo_snapshot_path).toMatchObject({
      type: "string",
      required: false,
    });
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("repo_snapshot_path");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("Never author acceptance criteria that depend on git history");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("HEAD~1");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("anchor on the exact expected text");
    expect(chain.steps.find((step) => step.id === "write-fix")).toMatchObject({
      tool: "fs.write_bundle",
      context: {
        files: "author-fix.fix_bundle.data.files",
      },
    });
    expect(chain.steps.find((step) => step.id === "author-fix")).toMatchObject({
      context: {
        spec_draft: "author-spec.spec_draft.data",
        spec_file: "read-spec.file_read.data",
        spec_contents: "read-spec.file_read.data.contents",
      },
    });
    expect(chain.steps.find((step) => step.id === "author-fix")?.instructions).toContain("fix_bundle.files");
    expect(chain.steps.find((step) => step.id === "author-fix")?.instructions).toContain("repo_snapshot_path");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")).toMatchObject({
      run: {
        type: "agent-step",
        task: "issue-to-pr-review",
      },
      context: {
        review_file: "scafld-review-open.review_file",
        review_prompt: "scafld-review-open.review_prompt",
        fix_bundle: "author-fix.fix_bundle.data",
        written_files: "write-fix.file_bundle_write.data.files",
        spec_contents: "read-spec.file_read.data.contents",
      },
    });
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("fix_bundle.files");
    expect(chain.steps.find((step) => step.id === "write-review")).toMatchObject({
      tool: "fs.write",
      context: {
        path: "scafld-review-open.review_file",
        contents: "reviewer-boundary.review_contents",
      },
    });
    expect(chain.steps.find((step) => step.id === "scafld-complete")).toMatchObject({
      context: {
        reviewer_result: "reviewer-boundary.review_decision.data",
      },
    });
  });

  it.skipIf(!existsSync(scafldBin))("completes the canonical issue-to-pr lane through authored spec, fix, and review outputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-issue-to-pr-skill-"));
    const receiptDir = path.join(tempDir, "receipts");
    const taskId = "issue-to-pr-skill-fixture";
    const caller: Caller = {
      resolve: async (request) =>
        request.kind === "cognitive_work"
          ? {
              actor: "agent",
              payload: await answerForIssueToPrStep(tempDir, taskId, request.id),
            }
          : undefined,
      report: () => undefined,
    };

    try {
      await initScafldRepo(tempDir);

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/issue-to-pr"),
        inputs: {
          fixture: tempDir,
          task_id: taskId,
          issue_title: "Fixture issue to PR",
          source: "github_issue",
          source_id: "123",
          source_url: "https://github.com/example/repo/issues/123",
          target_repo: "fixtures/repo",
          size: "micro",
          risk: "low",
          phase: "phase1",
          draft_spec_path: `.ai/specs/drafts/${taskId}.yaml`,
          scafld_bin: scafldBin,
        },
        caller,
        env: process.env,
        receiptDir,
        runxHome: path.join(tempDir, ".runx-test-home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.receipt.kind).toBe("chain_execution");
      if (result.receipt.kind !== "chain_execution") {
        return;
      }
      expect(result.receipt.subject.chain_name).toBe("issue-to-pr");
      expect(JSON.parse(result.execution.stdout)).toMatchObject({
        task_id: taskId,
        completed_state: "completed",
        verdict: "pass",
        blocking_count: 0,
        non_blocking_count: 0,
      });
      expect(result.receipt.steps.map((step) => [step.step_id, step.status])).toEqual([
        ["scafld-new", "success"],
        ["author-spec", "success"],
        ["write-spec", "success"],
        ["read-spec", "success"],
        ["scafld-validate", "success"],
        ["scafld-approve", "success"],
        ["scafld-start", "success"],
        ["author-fix", "success"],
        ["write-fix", "success"],
        ["scafld-exec", "success"],
        ["scafld-audit", "success"],
        ["scafld-review-open", "success"],
        ["reviewer-boundary", "success"],
        ["write-review", "success"],
        ["scafld-complete", "success"],
      ]);
      expect(await readFile(path.join(tempDir, "app.txt"), "utf8")).toBe("fixed\n");
      expect(await readFile(path.join(tempDir, "notes.md"), "utf8")).toBe("governed\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(!existsSync(scafldBin))("opens a structured scafld review, accepts a caller-filled review file, and completes from JSON verdict", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-issue-to-pr-"));
    const receiptDir = path.join(tempDir, "receipts");
    const taskId = "issue-to-pr-json-fixture";

    try {
      await initScafldRepo(tempDir);
      await writeActiveSpec(tempDir, taskId);

      const reviewResult = await runScafldSkill(tempDir, receiptDir, {
        command: "review",
        task_id: taskId,
      });
      expect(reviewResult.status).toBe("success");
      if (reviewResult.status !== "success") {
        return;
      }

      const reviewOpen = JSON.parse(reviewResult.execution.stdout) as {
        status: string;
        review_file: string;
        review_prompt: string;
      };
      expect(reviewOpen).toMatchObject({
        status: "review_open",
        review_file: `.ai/reviews/${taskId}.md`,
      });
      expect(reviewOpen.review_prompt).toContain("ADVERSARIAL REVIEW");

      await writePassingReviewFile(path.join(tempDir, reviewOpen.review_file), taskId);

      const completeResult = await runScafldSkill(tempDir, receiptDir, {
        command: "complete",
        task_id: taskId,
      });
      expect(completeResult.status).toBe("success");
      if (completeResult.status !== "success") {
        return;
      }

      expect(JSON.parse(completeResult.execution.stdout)).toMatchObject({
        task_id: taskId,
        completed_state: "completed",
        verdict: "pass",
        blocking_count: 0,
        non_blocking_count: 0,
        review_file: `.ai/reviews/${taskId}.md`,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});

async function runScafldSkill(
  fixture: string,
  receiptDir: string,
  inputs: Readonly<Record<string, unknown>>,
) {
  return await runLocalSkill({
    skillPath: path.resolve("skills/scafld"),
    runner: "scafld-cli",
    inputs: {
      ...inputs,
      fixture,
      scafld_bin: scafldBin,
    },
    caller,
    receiptDir,
    runxHome: path.join(fixture, ".runx-test-home"),
  });
}

async function initScafldRepo(repo: string): Promise<void> {
  runChecked("git", ["init", "-b", "main"], repo);
  runChecked("git", ["config", "user.email", "smoke@example.com"], repo);
  runChecked("git", ["config", "user.name", "Smoke Test"], repo);
  runChecked(scafldBin, ["init"], repo);
  await writeFile(path.join(repo, "app.txt"), "base\n");
  await writeFile(path.join(repo, "notes.md"), "draft\n");
  runChecked("git", ["add", "."], repo);
  runChecked("git", ["commit", "-m", "init"], repo);
}

async function writeActiveSpec(repo: string, taskId: string): Promise<void> {
  await writeFile(path.join(repo, "app.txt"), "base\n");
  await mkdir(path.join(repo, ".ai", "specs", "active"), { recursive: true });
  await writeFile(
    path.join(repo, ".ai", "specs", "active", `${taskId}.yaml`),
    `spec_version: "1.1"
task_id: "${taskId}"
created: "2026-04-10T00:00:00Z"
updated: "2026-04-10T00:00:00Z"
status: "in_progress"

task:
  title: "Issue to PR JSON Fixture"
  summary: "Fixture for runx scafld review handoff"
  size: "small"
  risk_level: "low"

phases:
  - id: "phase1"
    name: "Fixture"
    objective: "Provide one passing acceptance criterion"
    changes:
      - file: "app.txt"
        action: "update"
        content_spec: "Fixture file exists"
    acceptance_criteria:
      - id: "ac1_1"
        type: "custom"
        description: "app.txt exists"
        command: "test -f app.txt"
        expected: "exit code 0"
        result: "pass"

planning_log:
  - timestamp: "2026-04-10T00:00:00Z"
    actor: "test"
    summary: "Fixture spec"
`,
  );
}

async function answerForIssueToPrStep(
  repo: string,
  taskId: string,
  requestId: string,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (requestId === "agent_step.issue-to-pr-author-spec.output") {
    return {
      spec_draft: {
        path: `.ai/specs/drafts/${taskId}.yaml`,
        changed_files: [`.ai/specs/in_progress/${taskId}.yaml`, "app.txt"],
      },
      spec_contents: buildIssueToPrSpec(taskId),
    };
  }
  if (requestId === "agent_step.issue-to-pr-apply-fix.output") {
    return {
      fix_bundle: {
        summary: "Apply the bounded fixture fix declared in the spec across both tracked files.",
        files: [
          {
            path: "app.txt",
            contents: "fixed\n",
          },
          {
            path: "notes.md",
            contents: "governed\n",
          },
        ],
      },
    };
  }
  if (requestId === "agent_step.issue-to-pr-review.output") {
    const reviewFile = `.ai/reviews/${taskId}.md`;
    return {
      review_decision: {
        review_file: reviewFile,
        verdict: "pass",
        blocking_count: 0,
      },
      review_contents: await buildPassingReviewContents(path.join(repo, reviewFile), taskId),
    };
  }
  return undefined;
}

function buildIssueToPrSpec(taskId: string): string {
  return `spec_version: "1.1"
task_id: "${taskId}"
created: "2026-04-10T00:00:00Z"
updated: "2026-04-10T00:00:00Z"
status: "draft"

task:
  title: "Fixture issue to PR"
  summary: "Apply one bounded fixture fix and archive the completed review."
  size: "micro"
  risk_level: "low"
  context:
    packages:
      - "fixture"
    invariants:
      - "bounded_scope"
  objectives:
    - "Replace the fixture app contents with the fixed output."
    - "Update the companion notes file so the bounded fixture change stays consistent."
  touchpoints:
    - area: "fixture"
      description: "Update the tracked fixture files and keep the scafld spec declared."
  acceptance:
    definition_of_done:
      - id: "dod1"
        description: "app.txt contains the fixed output"
        status: "pending"
      - id: "dod2"
        description: "notes.md contains the governed output"
        status: "pending"
    validation:
      - id: "v1"
        type: "test"
        description: "app.txt contains the fixed output"
        command: "grep -q '^fixed$' app.txt"
        expected: "exit code 0"
      - id: "v2"
        type: "test"
        description: "notes.md contains the governed output"
        command: "grep -q '^governed$' notes.md"
        expected: "exit code 0"

planning_log:
  - timestamp: "2026-04-10T00:00:00Z"
    actor: "test"
    summary: "Fixture spec authored by the issue-to-pr lane"

phases:
  - id: "phase1"
    name: "Apply fixture fix"
    objective: "Write the bounded file change and validate it"
    changes:
      - file: ".ai/specs/in_progress/${taskId}.yaml"
        action: "update"
        content_spec: |
          The in-progress scafld spec is tracked and must stay in sync with the
          declared scope throughout execution.
      - file: "app.txt"
        action: "update"
        content_spec: |
          Replace the fixture contents with the fixed output.
      - file: "notes.md"
        action: "update"
        content_spec: |
          Keep the companion notes file aligned with the bounded fixture fix.
    acceptance_criteria:
      - id: "ac1_1"
        type: "test"
        description: "app.txt contains the fixed output"
        command: "grep -q '^fixed$' app.txt"
        expected: "exit code 0"
      - id: "ac1_2"
        type: "test"
        description: "notes.md contains the governed output"
        command: "grep -q '^governed$' notes.md"
        expected: "exit code 0"
    status: "pending"

rollback:
  strategy: "per_phase"
  commands:
    phase1: "git checkout HEAD -- .ai/specs/in_progress/${taskId}.yaml app.txt notes.md"
`;
}

async function writePassingReviewFile(reviewPath: string, taskId: string): Promise<void> {
  await writeFile(reviewPath, await buildPassingReviewContents(reviewPath, taskId));
}

async function buildPassingReviewContents(reviewPath: string, taskId: string): Promise<string> {
  await mkdir(path.dirname(reviewPath), { recursive: true });
  return `# Review: ${taskId}

## Spec
Issue to PR JSON Fixture

## Files Changed
- app.txt
- notes.md

---

## Review 1 — 2026-04-10T00:00:00Z

### Metadata
\`\`\`json
{
  "schema_version": 3,
  "round_status": "completed",
  "reviewer_mode": "executor",
  "reviewer_session": "",
  "reviewed_at": "2026-04-10T00:00:00Z",
  "override_reason": null,
  "pass_results": {
    "spec_compliance": "pass",
    "scope_drift": "pass",
    "regression_hunt": "pass",
    "convention_check": "pass",
    "dark_patterns": "pass"
  }
}
\`\`\`

### Pass Results
- spec_compliance: PASS
- scope_drift: PASS
- regression_hunt: PASS
- convention_check: PASS
- dark_patterns: PASS

### Regression Hunt

No issues found. Checked [app.txt](${reviewPath}):1 fixture scope.

### Convention Check

No issues found. Checked [app.txt](${reviewPath}):1 fixture scope.

### Dark Patterns

No issues found. Checked [app.txt](${reviewPath}):1 fixture scope.

### Blocking

None.

### Non-blocking

None.

### Verdict

pass
`;
}

function runChecked(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
}
