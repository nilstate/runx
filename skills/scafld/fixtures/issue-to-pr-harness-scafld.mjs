#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const command = argv[0] || "";
const taskId = argv[1] || "";
const cwd = process.cwd();
const specPath = path.join(cwd, ".scafld", "specs", "drafts", `${taskId}.md`);

switch (command) {
  case "init":
    mkdirSync(path.join(cwd, ".scafld", "specs", "drafts"), { recursive: true });
    emit({ ok: true, command, result: { Root: cwd, Created: [] } });
    break;
  case "plan":
    ensure(taskId, "task_id is required for plan");
    mkdirSync(path.dirname(specPath), { recursive: true });
    if (!existsSync(specPath)) {
      writeFileSync(specPath, renderSpec({ status: "draft" }));
    }
    emit({
      ok: true,
      command,
      result: {
        TaskID: taskId,
        Path: relativeToCwd(specPath),
        Status: "draft",
      },
    });
    break;
  case "validate":
    ensure(taskId, "task_id is required for validate");
    emit({
      ok: true,
      command,
      result: {
        TaskID: taskId,
        Path: relativeToCwd(specPath),
        Valid: true,
        Errors: null,
      },
    });
    break;
  case "approve":
    ensure(taskId, "task_id is required for approve");
    ensure(existsSync(specPath), "draft spec missing");
    replaceStatus("approved");
    emit({
      ok: true,
      command,
      result: {
        TaskID: taskId,
        Status: "approved",
        Path: relativeToCwd(specPath),
      },
    });
    break;
  case "build":
    ensure(taskId, "task_id is required for build");
    replaceStatus("review");
    emit({
      ok: true,
      command,
      result: {
        TaskID: taskId,
        Status: "review",
        Passed: 1,
        Failed: 0,
      },
    });
    break;
  case "status":
    ensure(taskId, "task_id is required for status");
    emit({
      ok: true,
      command,
      result: {
        TaskID: taskId,
        Status: currentStatus(),
        Title: readTitle(),
        Next: currentStatus() === "completed" ? "none" : "scafld review " + taskId,
        SessionOK: true,
      },
    });
    break;
  case "review":
    ensure(taskId, "task_id is required for review");
    emit({
      ok: true,
      command,
      result: {
        TaskID: taskId,
        Verdict: "pass",
        Findings: null,
      },
    });
    break;
  case "complete":
    ensure(taskId, "task_id is required for complete");
    replaceStatus("completed");
    emit({
      ok: true,
      command,
      result: {
        Version: "2.0",
        TaskID: taskId,
        Title: readTitle(),
        Summary: "Harness summary",
        Status: "completed",
        Review: {
          Status: "completed",
          Verdict: "pass",
        },
      },
    });
    break;
  case "handoff":
    ensure(taskId, "task_id is required for handoff");
    process.stdout.write(`# Handoff: ${readTitle()}\n\nStatus: ${currentStatus()}\nNext: none\n`);
    break;
  default:
    process.stderr.write(`unsupported command: ${command}\n`);
    process.exit(1);
}

function ensure(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function currentStatus() {
  if (!existsSync(specPath)) {
    return "draft";
  }
  const match = readFileSync(specPath, "utf8").match(/^status:\s*([^\n]+)$/m);
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "draft";
}

function readTitle() {
  if (!existsSync(specPath)) {
    return "Harness Task";
  }
  const match = readFileSync(specPath, "utf8").match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || "Harness Task";
}

function replaceStatus(status) {
  const contents = existsSync(specPath) ? readFileSync(specPath, "utf8") : renderSpec({ status });
  writeFileSync(specPath, contents.replace(/^status:\s*.+$/m, `status: ${status}`));
}

function renderSpec({ status }) {
  return `---
spec_version: '2.0'
task_id: ${taskId}
created: '2026-05-04T00:00:00Z'
updated: '2026-05-04T00:00:00Z'
status: ${status}
harden_status: not_run
size: micro
risk_level: low
---

# Harness Task

## Current State

Status: ${status}
Current phase: none
Next: none
Reason: none
Blockers: none
Allowed follow-up command: none
Latest runner update: none
Review gate: not_started

## Summary

Harness summary

## Context

CWD: \`. \`

Packages:
- fixture

Files impacted:
- \`README.md\`

Invariants:
- bounded_scope

Related docs:
- none

## Objectives

- Update README.md.

## Scope

- \`README.md\`

## Dependencies

- None.

## Assumptions

- None.

## Touchpoints

- README.md

## Risks

- None.

## Acceptance

Profile: standard

Definition of done:
- [ ] \`dod1\` README.md contains fixture guidance.

Validation:
- [ ] \`v1\` test - README contains fixture guidance.
  - Command: \`test -f README.md\`
  - Expected kind: \`exit_code_zero\`
  - Status: pending

## Phase 1: Update README

Goal: Update README.md.

Status: pending
Dependencies: none

Changes:
- \`README.md\` (all, exclusive) - Update README.md.

Acceptance:
- [ ] \`ac1_1\` test - README exists.
  - Command: \`test -f README.md\`
  - Expected kind: \`exit_code_zero\`
  - Status: pending

## Rollback

Strategy: per_phase

Commands:
- none

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
- harness

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

function relativeToCwd(targetPath) {
  return path.relative(cwd, targetPath);
}
