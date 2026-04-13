import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";

const scafldBin = process.env.SCAFLD_BIN ?? "/home/kam/dev/scafld/cli/scafld";

describe("recognizable work lanes", () => {
  it("runs support-triage through the local CLI with a bounded next-lane packet", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-support-triage-cli-"));
    const answersPath = path.join(tempDir, "answers.json");
    const receiptDir = path.join(tempDir, "receipts");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      await writeFile(
        answersPath,
        `${JSON.stringify(
          {
            answers: {
              "agent_step.support-triage.output": {
                triage_report: {
                  category: "docs",
                  severity: "low",
                  summary: "The public docs still route users through the compatibility alias instead of the canonical lane.",
                  suggested_reply: "We should update the docs to point users at issue-to-pr as the canonical lane.",
                  recommended_lane: "issue-to-pr",
                  rationale: "The request is a bounded docs-only fix in one repo.",
                  needs_human: false,
                  operator_notes: [],
                  issue_to_pr_request: {
                    task_id: "docs_issue_to_pr_command",
                    issue_title: "README still references bug-to-pr instead of issue-to-pr",
                    issue_body: "The public docs still tell users to run bug-to-pr as the canonical command.",
                    source: "github_issue",
                    source_id: "101",
                    source_url: "https://github.com/example/repo/issues/101",
                    size: "micro",
                    risk: "low",
                  },
                },
                change_set: {
                  change_set_id: "change_set_docs_issue_101",
                  source: {
                    type: "github_issue",
                    id: "101",
                    url: "https://github.com/example/repo/issues/101",
                  },
                  summary: "Update the docs to use issue-to-pr as the canonical lane name.",
                  category: "docs",
                  severity: "low",
                  recommended_lane: "issue-to-pr",
                  commence_decision: "approve",
                  action_decision: "proceed_to_build",
                  target_surfaces: [
                    {
                      surface: "oss-docs",
                      kind: "docs",
                      mutating: true,
                      rationale: "The problem is confined to the public documentation surface.",
                    },
                  ],
                  shared_invariants: [
                    "Keep bug-to-pr available as a compatibility alias.",
                  ],
                  success_criteria: [
                    "Public docs point to issue-to-pr as the canonical command.",
                  ],
                },
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const exitCode = await runCli(
        [
          "support-triage",
          "--title",
          "README still references bug-to-pr instead of issue-to-pr",
          "--body",
          "The public docs still tell users to run bug-to-pr as the canonical command.",
          "--source",
          "github_issue",
          "--source-id",
          "101",
          "--source-url",
          "https://github.com/example/repo/issues/101",
          "--operator-context",
          "Prefer the canonical issue-to-pr name in user-facing replies.",
          "--answers",
          answersPath,
          "--receipt-dir",
          receiptDir,
          "--non-interactive",
          "--json",
        ],
        { stdin: process.stdin, stdout, stderr },
        { ...process.env, RUNX_CWD: process.cwd() },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");
      expect(JSON.parse(stdout.contents())).toMatchObject({
        status: "success",
        skill: {
          name: "support-triage",
        },
        execution: {
          stdout: expect.stringContaining("\"recommended_lane\":\"issue-to-pr\""),
        },
        receipt: {
          kind: "skill_execution",
          status: "success",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync(scafldBin))("runs issue-to-pr end to end through the local CLI and completes the governed lane", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-issue-to-pr-cli-"));
    const answersPath = path.join(tempDir, "answers.json");
    const receiptDir = path.join(tempDir, "receipts");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const taskId = "recognizable-lane-fixture";

    try {
      await initScafldRepo(tempDir);
      await writeFile(
        answersPath,
        `${JSON.stringify(
          {
            answers: {
              "agent_step.issue-to-pr-author-spec.output": {
                spec_draft: {
                  path: `.ai/specs/drafts/${taskId}.yaml`,
                  changed_files: [`.ai/specs/in_progress/${taskId}.yaml`, "app.txt", "notes.md"],
                },
                spec_contents: buildIssueToPrSpec(taskId),
              },
              "agent_step.issue-to-pr-apply-fix.output": {
                fix_bundle: {
                  summary: "Apply the bounded fixture fix across the tracked docs fixture files.",
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
              },
              "agent_step.issue-to-pr-review.output": {
                review_decision: {
                  review_file: `.ai/reviews/${taskId}.md`,
                  verdict: "pass",
                  blocking_count: 0,
                },
                review_contents: buildPassingReviewContents(taskId),
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const exitCode = await runCli(
        [
          "skill",
          "skills/issue-to-pr",
          "--fixture",
          tempDir,
          "--task-id",
          taskId,
          "--issue-title",
          "Fixture issue to PR",
          "--issue-body",
          "Apply a bounded fixture docs update.",
          "--source",
          "github_issue",
          "--source-id",
          "123",
          "--source-url",
          "https://github.com/example/repo/issues/123",
          "--target-repo",
          "fixtures/repo",
          "--size",
          "micro",
          "--risk",
          "low",
          "--phase",
          "phase1",
          "--draft-spec-path",
          `.ai/specs/drafts/${taskId}.yaml`,
          "--scafld-bin",
          scafldBin,
          "--answers",
          answersPath,
          "--receipt-dir",
          receiptDir,
          "--non-interactive",
          "--json",
        ],
        { stdin: process.stdin, stdout, stderr },
        { ...process.env, RUNX_CWD: process.cwd() },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");
      expect(JSON.parse(stdout.contents())).toMatchObject({
        status: "success",
        skill: {
          name: "issue-to-pr",
        },
        execution: {
          stdout: expect.stringContaining(`"task_id":"${taskId}"`),
        },
        receipt: {
          kind: "chain_execution",
          status: "success",
        },
      });
      await expect(readFile(path.join(tempDir, "app.txt"), "utf8")).resolves.toBe("fixed\n");
      await expect(readFile(path.join(tempDir, "notes.md"), "utf8")).resolves.toBe("governed\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 90_000);
});

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string } {
  let contents = "";
  return {
    write(chunk: unknown) {
      contents += String(chunk);
      return true;
    },
    contents: () => contents,
  } as NodeJS.WriteStream & { contents: () => string };
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

function runChecked(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status === 0) {
    return;
  }
  throw new Error(`command failed: ${command} ${args.join(" ")}\n${result.stderr || result.stdout}`);
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

function buildPassingReviewContents(taskId: string): string {
  const reviewPath = `.ai/reviews/${taskId}.md`;
  return `# Review: ${taskId}

## Spec
Recognizable work lanes CLI fixture

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
