import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultLocalSkillRuntime } from "../packages/adapters/src/runtime.js";
import { parseRunnerManifestYaml, validateRunnerManifest } from "@runxhq/core/parser";
import { runLocalSkill, type Caller } from "@runxhq/runtime-local";

const scafldBin = process.env.SCAFLD_BIN ?? "scafld";
const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("issue-to-PR composite skill", () => {
  it("models authored content around native scafld v2 lifecycle and handoff packaging", async () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(await readFile(path.resolve("skills/issue-to-pr/X.yaml"), "utf8")),
    );
    const runner = manifest.runners["issue-to-pr"];

    expect(runner?.source.type).toBe("graph");
    if (!runner || runner.source.type !== "graph" || !runner.source.graph) {
      throw new Error("issue-to-pr runner must declare an inline graph.");
    }
    const graph = runner.source.graph;

    expect(graph.steps.map((step) => step.id)).toEqual([
      "scafld-plan",
      "author-spec",
      "write-spec",
      "read-draft-spec",
      "scafld-validate",
      "scafld-approve",
      "read-approved-spec",
      "read-declared-files",
      "author-fix",
      "write-fix",
      "scafld-build",
      "scafld-status",
      "read-current-branch",
      "scafld-review",
      "scafld-complete",
      "scafld-final-status",
      "scafld-handoff",
      "package-pull-request",
      "push-pull-request",
    ]);
    expect(graph.steps.map((step) => step.inputs.command).filter(Boolean)).toEqual([
      "plan",
      "validate",
      "approve",
      "build",
      "status",
      "review",
      "complete",
      "status",
      "handoff",
    ]);
    expect(graph.steps.find((step) => step.id === "author-spec")?.instructions).toContain("scafld 2.0 markdown spec");
    expect(graph.steps.find((step) => step.id === "author-fix")?.instructions).toContain("fix_bundle.status: blocked");
    expect(graph.steps.find((step) => step.id === "package-pull-request")).toMatchObject({
      tool: "outbox.build_pull_request",
      context: {
        handoff_markdown: "scafld-handoff.stdout",
        build_result: "scafld-build.result",
        review_result: "scafld-review.result",
        completion_result: "scafld-complete.result",
        status_snapshot: "scafld-final-status.result",
        current_branch: "read-current-branch.git_branch.data",
      },
    });
    expect(graph.steps.find((step) => step.id === "read-current-branch")).toMatchObject({
      tool: "git.current_branch",
    });
  });

  it.skipIf(!hasScafld())("completes the canonical issue-to-pr lane through scafld 2.2 build, review, complete, and handoff", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-issue-to-pr-skill-"));
    const runtime = await createExternalRuntime("runx-issue-to-pr-runtime-");
    const taskId = "issue-to-pr-skill-fixture";
    const caller: Caller = {
      resolve: async (request) =>
        request.kind === "cognitive_work"
          ? {
              actor: "agent",
              payload: answerForIssueToPrStep(taskId, request),
            }
          : undefined,
      report: () => undefined,
    };

    try {
      await initScafldRepo(tempDir);
      runChecked("git", ["checkout", "-b", taskId], tempDir);

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/issue-to-pr"),
        inputs: {
          fixture: tempDir,
          task_id: taskId,
          thread_title: "Fixture thread-driven change",
          thread_body: "Apply a bounded fixture docs update.",
          thread_locator: "github://example/repo/issues/123",
          target_repo: "fixtures/repo",
          size: "micro",
          risk: "low",
          base: "main",
          provider: "local",
          scafld_bin: scafldBin,
        },
        caller,
        adapters: runtime.adapters,
        env: runtime.env,
        receiptDir: runtime.paths.receiptDir,
        runxHome: runtime.paths.runxHome,
      });

      if (result.status !== "success") {
        throw new Error(JSON.stringify(result, null, 2));
      }
      expect(result.receipt.kind).toBe("graph_execution");
      if (result.receipt.kind !== "graph_execution") {
        return;
      }
      const output = JSON.parse(result.execution.stdout);
      expect(output).toMatchObject({
        outbox_entry: {
          kind: "pull_request",
          status: "proposed",
          entry_id: `pull_request:${taskId}`,
          metadata: {
            action: "create",
            repo: "fixtures/repo",
            branch: taskId,
            base: "main",
            review_verdict: "pass",
            check_status: "success",
            push_ready: true,
          },
        },
        draft_pull_request: {
          schema_version: "runx.pull-request-draft.v1",
          action: "create",
          push_ready: true,
          task_id: taskId,
          target: {
            repo: "fixtures/repo",
            branch: taskId,
            base: "main",
          },
          pull_request: {
            title: "Fixture thread-driven change",
            body_markdown: expect.stringContaining("# Handoff: Fixture thread-driven change"),
            is_draft: true,
          },
          governance: {
            status: "completed",
            review_verdict: "pass",
            build_failed: 0,
          },
        },
        push: {
          status: "skipped",
          reason: "thread not provided",
        },
      });
      expect(result.receipt.steps.map((step) => [step.step_id, step.status])).toEqual([
        ["scafld-plan", "success"],
        ["author-spec", "success"],
        ["write-spec", "success"],
        ["read-draft-spec", "success"],
        ["scafld-validate", "success"],
        ["scafld-approve", "success"],
        ["read-approved-spec", "success"],
        ["read-declared-files", "success"],
        ["author-fix", "success"],
        ["write-fix", "success"],
        ["scafld-build", "success"],
        ["scafld-status", "success"],
        ["read-current-branch", "success"],
        ["scafld-review", "success"],
        ["scafld-complete", "success"],
        ["scafld-final-status", "success"],
        ["scafld-handoff", "success"],
        ["package-pull-request", "success"],
        ["push-pull-request", "success"],
      ]);
      await expect(readFile(path.join(tempDir, "app.txt"), "utf8")).resolves.toBe("fixed\n");
      await expect(readFile(path.join(tempDir, "notes.md"), "utf8")).resolves.toBe("governed\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(runtime.paths.root, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(!hasScafld())("halts before write-fix when author-fix explicitly reports blocked after declared-file preload", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-issue-to-pr-blocked-"));
    const runtime = await createExternalRuntime("runx-issue-to-pr-runtime-");
    const taskId = "issue-to-pr-blocked-fixture";
    const blockedCaller: Caller = {
      resolve: async (request) =>
        request.kind === "cognitive_work"
          ? {
              actor: "agent",
              payload:
                request.id === "agent_step.issue-to-pr-author-spec.output"
                  ? {
                      spec_contents: buildIssueToPrSpec(taskId),
                    }
                  : request.id === "agent_step.issue-to-pr-apply-fix.output"
                    ? {
                        fix_bundle: {
                          status: "blocked",
                          reason: "Need one more grounded read before editing.",
                          files: [],
                        },
                      }
                    : undefined,
            }
          : undefined,
      report: () => undefined,
    };

    try {
      await initScafldRepo(tempDir);
      runChecked("git", ["checkout", "-b", taskId], tempDir);

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/issue-to-pr"),
        inputs: {
          fixture: tempDir,
          task_id: taskId,
          thread_title: "Blocked fixture thread-driven change",
          thread_body: "Apply a bounded fixture docs update.",
          thread_locator: "github://example/repo/issues/456",
          target_repo: "fixtures/repo",
          provider: "local",
          scafld_bin: scafldBin,
        },
        caller: blockedCaller,
        adapters: runtime.adapters,
        env: runtime.env,
        receiptDir: runtime.paths.receiptDir,
        runxHome: runtime.paths.runxHome,
      });

      expect(result.status).toBe("policy_denied");
      if (result.status !== "policy_denied") {
        return;
      }

      expect(result.reasons).toEqual([
        "transition policy blocked step 'write-fix': expected author-fix.fix_bundle.data.files != []",
      ]);
      await expect(readFile(path.join(tempDir, "app.txt"), "utf8")).resolves.toBe("base\n");
      await expect(readFile(path.join(tempDir, "notes.md"), "utf8")).resolves.toBe("draft\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(runtime.paths.root, { recursive: true, force: true });
    }
  }, 90_000);
});

function hasScafld(): boolean {
  const result = spawnSync(scafldBin, ["--version"], { encoding: "utf8" });
  return result.status === 0;
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

async function createExternalRuntime(prefix: string) {
  return await createDefaultLocalSkillRuntime({
    prefix,
    env: process.env,
  });
}

function answerForIssueToPrStep(
  taskId: string,
  request: Parameters<Caller["resolve"]>[0],
): Readonly<Record<string, unknown>> | undefined {
  if (request.id === "agent_step.issue-to-pr-author-spec.output") {
    return {
      spec_contents: buildIssueToPrSpec(taskId),
    };
  }
  if (request.id === "agent_step.issue-to-pr-apply-fix.output") {
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
  return undefined;
}

function buildIssueToPrSpec(taskId: string): string {
  return `---
spec_version: '2.0'
task_id: ${taskId}
created: '2026-05-04T00:00:00Z'
updated: '2026-05-04T00:00:00Z'
status: draft
harden_status: not_run
size: micro
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
Timestamp: none
Review rounds: none
Reviewer mode: none
Reviewer session: none
Round status: none
Override applied: none
Override reason: none
Override confirmed at: none
Reviewed head: none
Reviewed dirty: none
Reviewed diff: none
Blocking count: none
Non-blocking count: none

Findings:
- none

Passes:
- none

## Self Eval

Status: not_started
Completeness: none
Architecture fidelity: none
Spec alignment: none
Validation depth: none
Total: none
Second pass performed: none

Notes:
none

Improvements:
- none

## Deviations

- none

## Metadata

Estimated effort hours: none
Actual effort hours: none
AI model: none
React cycles: none

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

function runChecked(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  throw new Error(`command failed: ${command} ${args.join(" ")}\n${result.stderr || result.stdout}`);
}
