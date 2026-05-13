import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";

const scafldBin = process.env.SCAFLD_BIN ?? "scafld";
const passingReviewCommand = `printf '{"verdict":"pass","mode":"discover","summary":"fixture clean","findings":[],"attack_log":[{"target":"diff","attack":"fixture","result":"clean"}],"budget":{"actual_attack_angles":1}}'`;

describe("recognizable work lanes", () => {
  it("runs intake through the local CLI with a bounded next-lane packet", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-intake-cli-"));
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
              "agent_task.intake.output": {
                triage_report: {
                  category: "docs",
                  severity: "low",
                  summary: "The public docs still route users through the removed lane name instead of the canonical lane.",
                  suggested_reply: "We should update the docs to point users at issue-to-pr as the canonical lane.",
                  recommended_lane: "issue-to-pr",
                  rationale: "The request is a bounded docs-only fix in one repo.",
                  needs_human: false,
                  operator_notes: [],
                  thread_change_request: {
                    task_id: "docs_issue_to_pr_command",
                    thread_title: "README should point users to issue-to-pr",
                    thread_body: "The public docs should present issue-to-pr as the canonical command.",
                    thread_locator: "github://example/repo/issues/101",
                    size: "small",
                    risk: "low",
                  },
                },
                change_set: {
                  change_set_id: "change_set_docs_work_101",
                  thread_locator: "github://example/repo/issues/101",
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
                  shared_invariants: [],
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
          "skill",
          "skills/intake",
          "--thread-title",
          "README should point users to issue-to-pr",
          "--thread-body",
          "The public docs should present issue-to-pr as the canonical command.",
          "--thread-locator",
          "github://example/repo/issues/101",
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

      expect(exitCode, `${stderr.contents()}\n${stdout.contents()}`).toBe(0);
      expect(stderr.contents()).toBe("");
      expect(JSON.parse(stdout.contents())).toMatchObject({
        status: "success",
        skill: {
          name: "intake",
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

  it.skipIf(!hasScafld())("runs issue-to-pr through the local CLI and packages a draft pull request", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-issue-to-pr-cli-"));
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "runx-issue-to-pr-cli-runtime-"));
    const answersPath = path.join(runtimeDir, "answers.json");
    const receiptDir = path.join(runtimeDir, "receipts");
    const runxHome = path.join(runtimeDir, "home");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const taskId = "recognizable-lane-fixture";

    try {
      await initScafldRepo(tempDir);
      runChecked("git", ["checkout", "-b", taskId], tempDir);
      await writeFile(
        answersPath,
        `${JSON.stringify(
          {
            answers: {
              "agent_task.issue-to-pr-author-spec.output": {
                spec_contents: buildIssueToPrSpec(taskId),
              },
              "agent_task.issue-to-pr-apply-fix.output": {
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
          "--thread-title",
          "Fixture thread-driven change",
          "--thread-body",
          "Apply a bounded fixture docs update.",
          "--thread-locator",
          "github://example/repo/issues/123",
          "--target-repo",
          "fixtures/repo",
          "--size",
          "small",
          "--risk",
          "low",
          "--provider",
          "command",
          "--provider-command",
          passingReviewCommand,
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
        { ...process.env, RUNX_CWD: tempDir, RUNX_HOME: runxHome },
      );

      expect(exitCode, `${stderr.contents()}\n${stdout.contents()}`).toBe(0);
      expect(stderr.contents()).toBe("");
      expect(JSON.parse(stdout.contents())).toMatchObject({
        status: "success",
        skill: {
          name: "issue-to-pr",
        },
        execution: {
          stdout: expect.stringContaining("\"draft_pull_request\""),
        },
      });
      await expect(readFile(path.join(tempDir, "app.txt"), "utf8")).resolves.toBe("fixed\n");
      await expect(readFile(path.join(tempDir, "notes.md"), "utf8")).resolves.toBe("governed\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(runtimeDir, { recursive: true, force: true });
    }
  }, 90_000);
});

function hasScafld(): boolean {
  const result = spawnSync(scafldBin, ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

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
  return `---
spec_version: '2.0'
task_id: ${taskId}
created: '2026-05-04T00:00:00Z'
updated: '2026-05-04T00:00:00Z'
status: draft
harden_status: not_run
size: small
risk_level: low
---

# Fixture thread-driven change

## Current State

Status: draft
Current phase: none
Next: none
Reason: none
Blockers: none
Allowed follow-up command: none
Latest runner update: none
Review gate: not_started

## Summary

Apply one bounded fixture fix and complete native review.

## Context

CWD: \`. \`

Packages:
- fixture

Files impacted:
- \`app.txt\`
- \`notes.md\`

Invariants:
- bounded_scope

Related docs:
- none

## Objectives

- Replace the fixture app contents with the fixed output.
- Update the companion notes file so the bounded fixture change stays consistent.

## Scope

- \`app.txt\`
- \`notes.md\`

## Dependencies

- None.

## Assumptions

- None.

## Touchpoints

- Fixture text files.

## Risks

- None.

## Acceptance

Profile: standard

Definition of done:
- [ ] \`dod1\` app.txt contains the fixed output.
- [ ] \`dod2\` notes.md contains the governed output.

Validation:
- [ ] \`v1\` test - app.txt contains the fixed output.
  - Command: \`grep -q '^fixed$' app.txt\`
  - Expected kind: \`exit_code_zero\`
  - Timeout seconds: none
  - Result: none
  - Status: pending
  - Evidence: none
  - Source event: none
  - Last attempt: none
  - Checked at: none
- [ ] \`v2\` test - notes.md contains the governed output.
  - Command: \`grep -q '^governed$' notes.md\`
  - Expected kind: \`exit_code_zero\`
  - Timeout seconds: none
  - Result: none
  - Status: pending
  - Evidence: none
  - Source event: none
  - Last attempt: none
  - Checked at: none

## Phase 1: Apply fixture fix

Goal: Write the bounded file change and validate it.

Status: pending
Dependencies: none

Changes:
- \`app.txt\` (all, exclusive) - Replace the fixture contents with the fixed output.
- \`notes.md\` (all, exclusive) - Keep the companion notes file aligned with the bounded fixture fix.

Acceptance:
- [ ] \`ac1_1\` test - app.txt contains the fixed output.
  - Command: \`grep -q '^fixed$' app.txt\`
  - Expected kind: \`exit_code_zero\`
  - Timeout seconds: none
  - Result: none
  - Status: pending
  - Evidence: none
  - Source event: none
  - Last attempt: none
  - Checked at: none
- [ ] \`ac1_2\` test - notes.md contains the governed output.
  - Command: \`grep -q '^governed$' notes.md\`
  - Expected kind: \`exit_code_zero\`
  - Timeout seconds: none
  - Result: none
  - Status: pending
  - Evidence: none
  - Source event: none
  - Last attempt: none
  - Checked at: none

## Rollback

Strategy: per_phase

Commands:
- \`git checkout HEAD -- app.txt notes.md\`

## Review

Status: not_started
Verdict: none

Findings:
- none

Passes:
- none

## Self Eval

Status: not_started

Notes:
none

Improvements:
- none

## Deviations

- none

## Metadata

Tags:
- fixture

## Origin

Source:
- runx-test

Repo:
- none

Git:
- none

Sync:
- none

Supersession:
- none

## Harden Rounds

- none

## Planning Log

- none
`;
}
