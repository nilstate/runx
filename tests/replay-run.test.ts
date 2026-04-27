import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { inspectLocalReceipt, readLocalReplaySeed } from "@runxhq/runtime-local";
import { runCli } from "../packages/cli/src/index.js";

describe("run replay", () => {
  it("replays a completed run from its local ledger seed and stamps lineage into the new receipt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-replay-run-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const firstStdout = createMemoryStream();
      const firstExit = await runCli(
        ["skill", "fixtures/skills/echo", "--message", "hi", "--receipt-dir", receiptDir, "--json"],
        { stdin: process.stdin, stdout: firstStdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_HOME: runxHome,
        },
      );
      expect(firstExit).toBe(0);
      const first = JSON.parse(firstStdout.contents()) as { readonly receipt: { readonly id: string } };

      await expect(readLocalReplaySeed({ referenceId: first.receipt.id, receiptDir, runxHome })).resolves.toMatchObject({
        runId: first.receipt.id,
        receiptId: first.receipt.id,
        lineage: {
          kind: "rerun",
          sourceRunId: first.receipt.id,
          sourceReceiptId: first.receipt.id,
        },
      });

      const replayStdout = createMemoryStream();
      const replayExit = await runCli(
        ["replay", first.receipt.id, "--receipt-dir", receiptDir, "--json"],
        { stdin: process.stdin, stdout: replayStdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_HOME: runxHome,
        },
      );
      expect(replayExit).toBe(0);
      const replay = JSON.parse(replayStdout.contents()) as {
        readonly receipt: {
          readonly id: string;
          readonly metadata?: Readonly<Record<string, unknown>>;
        };
      };
      expect(replay.receipt.id).not.toBe(first.receipt.id);

      await expect(inspectLocalReceipt({ receiptDir, runxHome, receiptId: replay.receipt.id })).resolves.toMatchObject({
        summary: {
          id: replay.receipt.id,
          lineage: {
            kind: "rerun",
            sourceRunId: first.receipt.id,
            sourceReceiptId: first.receipt.id,
          },
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps paused runs on the resume path instead of replay", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-replay-paused-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const pausedStdout = createMemoryStream();
      const pausedExit = await runCli(
        ["skill", "fixtures/skills/echo", "--receipt-dir", receiptDir, "--non-interactive", "--json"],
        { stdin: process.stdin, stdout: pausedStdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_HOME: runxHome,
        },
      );
      expect(pausedExit).toBe(2);
      const paused = JSON.parse(pausedStdout.contents()) as { readonly run_id: string };

      const replayStderr = createMemoryStream();
      const replayExit = await runCli(
        ["replay", paused.run_id, "--receipt-dir", receiptDir, "--json"],
        { stdin: process.stdin, stdout: createMemoryStream(), stderr: replayStderr },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_HOME: runxHome,
        },
      );
      expect(replayExit).toBe(1);
      expect(replayStderr.contents()).toContain("Use 'runx resume");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("replays a graph run after it pauses once and later completes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-replay-graph-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");
    const childDir = path.join(tempDir, "child-task");
    const wrapperDir = path.join(tempDir, "wrapper-task");
    const answersPath = path.join(tempDir, "answers.json");

    try {
      await mkdir(childDir, { recursive: true });
      await mkdir(path.join(wrapperDir, ".runx"), { recursive: true });
      await writeFile(
        path.join(childDir, "SKILL.md"),
        `---
name: child-task
description: Temporary delegated fixture that echoes a task id through an agent boundary.
source:
  type: agent-step
  agent: codex
  task: child-task
  outputs:
    echoed_task: string
inputs:
  task_id:
    type: string
    required: false
    default: default-task
---
Return the provided task id.
`,
      );
      await writeFile(
        path.join(wrapperDir, "SKILL.md"),
        `---
name: wrapper-task
description: Compatibility wrapper that delegates to child-task.
---
Delegate to child-task.
`,
      );
      const profileDocument = `skill: wrapper-task

runners:
  wrapper-task:
    default: true
    type: graph
    inputs:
      task_id:
        type: string
        required: false
        default: default-task
    graph:
      name: wrapper-task
      owner: test
      steps:
        - id: delegate
          label: delegate task
          skill: ../child-task/SKILL.md
          mutation: false
`;
      await writeFile(
        path.join(wrapperDir, ".runx/profile.json"),
        `${JSON.stringify(
          {
            schema_version: "runx.skill-profile.v1",
            skill: {
              name: "wrapper-task",
              path: "SKILL.md",
              digest: "fixture-skill-digest",
            },
            profile: {
              document: profileDocument,
              digest: "fixture-profile-digest",
              runner_names: ["wrapper-task"],
            },
            origin: {
              source: "fixture",
            },
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        answersPath,
        `${JSON.stringify(
          {
            answers: {
              "agent_step.child-task.output": {
                echoed_task: "abc-123",
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const pausedStdout = createMemoryStream();
      const pausedExit = await runCli(
        [wrapperDir, "--task-id", "abc-123", "--receipt-dir", receiptDir, "--non-interactive", "--json"],
        { stdin: process.stdin, stdout: pausedStdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_HOME: runxHome,
        },
      );
      expect(pausedExit).toBe(2);
      const paused = JSON.parse(pausedStdout.contents()) as { readonly run_id: string };

      const resumedStdout = createMemoryStream();
      const resumedExit = await runCli(
        ["resume", paused.run_id, "--answers", answersPath, "--receipt-dir", receiptDir, "--non-interactive", "--json"],
        { stdin: process.stdin, stdout: resumedStdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_HOME: runxHome,
        },
      );
      expect(resumedExit).toBe(0);
      const resumed = JSON.parse(resumedStdout.contents()) as { readonly receipt: { readonly id: string } };
      expect(resumed.receipt.id).toBe(paused.run_id);

      await expect(readLocalReplaySeed({ referenceId: paused.run_id, receiptDir, runxHome })).resolves.toMatchObject({
        runId: paused.run_id,
        receiptId: paused.run_id,
        lineage: {
          kind: "rerun",
          sourceRunId: paused.run_id,
          sourceReceiptId: paused.run_id,
        },
      });

      const replayStdout = createMemoryStream();
      const replayExit = await runCli(
        ["replay", paused.run_id, "--answers", answersPath, "--receipt-dir", receiptDir, "--non-interactive", "--json"],
        { stdin: process.stdin, stdout: replayStdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_HOME: runxHome,
        },
      );
      expect(replayExit).toBe(0);
      const replay = JSON.parse(replayStdout.contents()) as {
        readonly receipt: {
          readonly id: string;
        };
      };
      expect(replay.receipt.id).not.toBe(paused.run_id);

      await expect(inspectLocalReceipt({ receiptDir, runxHome, receiptId: replay.receipt.id })).resolves.toMatchObject({
        summary: {
          id: replay.receipt.id,
          lineage: {
            kind: "rerun",
            sourceRunId: paused.run_id,
            sourceReceiptId: paused.run_id,
          },
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
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
