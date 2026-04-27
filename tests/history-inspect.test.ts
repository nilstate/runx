import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { appendLedgerEntries, createArtifactEnvelope } from "@runxhq/core/artifacts";
import { createFileKnowledgeStore } from "@runxhq/core/knowledge";
import { writeLocalReceipt } from "@runxhq/core/receipts";
import { inspectLocalReceipt, listLocalHistory } from "@runxhq/runtime-local";

describe("history, inspect, and knowledge CLI", () => {
  it("uses receipt files for history/inspect and knowledge for project projections", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-history-inspect-"));
    const receiptDir = path.join(tempDir, "receipts");
    const knowledgeDir = path.join(tempDir, "knowledge");
    const project = path.join(tempDir, "project");

    try {
      const runStdout = createMemoryStream();
      const runStderr = createMemoryStream();
      const runExit = await runCli(
        [
          "skill",
          "fixtures/skills/echo",
          "--message",
          "hi",
          "--receipt-dir",
          receiptDir,
          "--json",
        ],
        { stdin: process.stdin, stdout: runStdout, stderr: runStderr },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
        },
      );
      expect(runExit).toBe(0);
      expect(runStderr.contents()).toBe("");
      const runReport = JSON.parse(runStdout.contents()) as { receipt: { id: string } };

      const historyStdout = createMemoryStream();
      const historyExit = await runCli(
        ["history", "echo", "--receipt-dir", receiptDir, "--json"],
        { stdin: process.stdin, stdout: historyStdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
        },
      );
      expect(historyExit).toBe(0);
      expect(JSON.parse(historyStdout.contents())).toMatchObject({
        status: "success",
        query: "echo",
        receipts: [
          {
            id: runReport.receipt.id,
            kind: "skill_execution",
            name: "echo",
            sourceType: "cli-tool",
          },
        ],
      });

      const inspectStdout = createMemoryStream();
      const inspectExit = await runCli(
        ["skill", "inspect", runReport.receipt.id, "--receipt-dir", receiptDir, "--json"],
        { stdin: process.stdin, stdout: inspectStdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
        },
      );
      expect(inspectExit).toBe(0);
      expect(JSON.parse(inspectStdout.contents())).toMatchObject({
        summary: {
          id: runReport.receipt.id,
          kind: "skill_execution",
          name: "echo",
        },
      });

      await createFileKnowledgeStore(knowledgeDir).addProjection({
        project,
        scope: "project",
        key: "homepage_url",
        value: "https://example.test",
        source: "test",
        confidence: 0.95,
        freshness: "fresh",
        receiptId: runReport.receipt.id,
        createdAt: "2026-04-10T00:00:00Z",
      });

      const knowledgeStdout = createMemoryStream();
      const knowledgeExit = await runCli(
        ["knowledge", "show", "--project", project, "--json"],
        { stdin: process.stdin, stdout: knowledgeStdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_KNOWLEDGE_DIR: knowledgeDir,
          RUNX_CWD: process.cwd(),
        },
      );
      expect(knowledgeExit).toBe(0);
      expect(JSON.parse(knowledgeStdout.contents())).toMatchObject({
        status: "success",
        project,
        projections: [
          {
            key: "homepage_url",
            value: "https://example.test",
            receipt_id: runReport.receipt.id,
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("filters local history by actor and artifact type and exposes the same summary through inspect", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-history-filters-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const builderReceiptId = "rx_historybuilder0001";
      const builderArtifact = createArtifactEnvelope({
        type: "draft_pull_request",
        data: { title: "Draft PR" },
        runId: builderReceiptId,
        producer: { skill: "draft-content", runner: "agent-step" },
      });
      await writeLocalReceipt({
        receiptId: builderReceiptId,
        receiptDir,
        runxHome,
        skillName: "draft-content",
        sourceType: "agent-step",
        inputs: { objective: "draft a pull request" },
        stdout: JSON.stringify({ ok: true }),
        stderr: "",
        execution: {
          status: "success",
          exitCode: 0,
          signal: null,
          durationMs: 2,
          metadata: {
            agent_hook: {
              source_type: "agent-step",
              agent: "builder",
              task: "draft-pr",
              route: "provided",
              status: "success",
            },
            runner: {
              provider: "openai",
            },
          },
        },
        artifactIds: [builderArtifact.meta.artifact_id],
        startedAt: "2026-04-24T00:00:00Z",
        completedAt: "2026-04-24T00:00:01Z",
      });
      await appendLedgerEntries({
        receiptDir,
        runId: builderReceiptId,
        entries: [builderArtifact],
      });

      const reviewerReceiptId = "rx_historyreviewer0001";
      const reviewerArtifact = createArtifactEnvelope({
        type: "triage_packet",
        data: { verdict: "needs follow-up" },
        runId: reviewerReceiptId,
        producer: { skill: "request-triage", runner: "cli-tool" },
      });
      await writeLocalReceipt({
        receiptId: reviewerReceiptId,
        receiptDir,
        runxHome,
        skillName: "request-triage",
        sourceType: "cli-tool",
        inputs: { thread: "support request" },
        stdout: JSON.stringify({ ok: true }),
        stderr: "",
        execution: {
          status: "success",
          exitCode: 0,
          signal: null,
          durationMs: 2,
          metadata: {
            runner: {
              provider: "anthropic",
            },
          },
        },
        artifactIds: [reviewerArtifact.meta.artifact_id],
        startedAt: "2026-04-24T00:10:00Z",
        completedAt: "2026-04-24T00:10:01Z",
      });
      await appendLedgerEntries({
        receiptDir,
        runId: reviewerReceiptId,
        entries: [reviewerArtifact],
      });

      await expect(listLocalHistory({ receiptDir, runxHome, actor: "builder" })).resolves.toMatchObject({
        receipts: [
          {
            id: builderReceiptId,
            actors: ["builder", "openai"],
            artifactTypes: ["draft_pull_request"],
          },
        ],
      });

      await expect(listLocalHistory({ receiptDir, runxHome, artifactType: "triage_packet" })).resolves.toMatchObject({
        receipts: [
          {
            id: reviewerReceiptId,
            artifactTypes: ["triage_packet"],
          },
        ],
      });

      await expect(inspectLocalReceipt({ receiptDir, runxHome, receiptId: builderReceiptId })).resolves.toMatchObject({
        summary: {
          id: builderReceiptId,
          actors: ["builder", "openai"],
          artifactTypes: ["draft_pull_request"],
        },
      });

      const historyStdout = createMemoryStream();
      const historyExit = await runCli(
        ["history", "--actor", "builder", "--artifact-type", "draft_pull_request", "--receipt-dir", receiptDir, "--json"],
        { stdin: process.stdin, stdout: historyStdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_HOME: runxHome,
        },
      );
      expect(historyExit).toBe(0);
      expect(JSON.parse(historyStdout.contents())).toMatchObject({
        status: "success",
        filters: {
          actor: "builder",
          artifact_type: "draft_pull_request",
        },
        receipts: [
          {
            id: builderReceiptId,
            actors: ["builder", "openai"],
            artifactTypes: ["draft_pull_request"],
          },
        ],
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
