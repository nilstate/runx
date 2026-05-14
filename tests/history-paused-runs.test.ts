import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { inspectLocalRun, listLocalHistory } from "@runxhq/runtime-local";
import { appendLedgerEntries, createRunEventEntry } from "@runxhq/core/artifacts";

const writePausedLedger = async (receiptDir: string, runId: string, skillName: string) => {
  const created = "2026-04-28T01:00:00.000Z";
  const producer = { skill: skillName, runner: "graph" };
  await appendLedgerEntries({
    receiptDir,
    runId,
    entries: [
      createRunEventEntry({
        runId,
        producer,
        kind: "run_started",
        status: "started",
        createdAt: created,
      }),
      createRunEventEntry({
        runId,
        stepId: "discover",
        producer,
        kind: "step_waiting_resolution",
        status: "waiting",
        detail: {
          request_ids: ["agent_step.test-step.output"],
          resolution_kinds: ["cognitive_work"],
          step_ids: ["discover"],
          step_labels: ["inspect repo"],
          inputs: {},
          selected_runner: "agent-step",
        },
        createdAt: created,
      }),
    ],
  });
};

describe("paused runs surface in history and inspect", () => {
  it("listLocalHistory includes paused runs from ledgers", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-paused-history-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runId = "gx_paused0000000000000000000000ab";

    try {
      await writePausedLedger(receiptDir, runId, "sourcey");

      const result = await listLocalHistory({ receiptDir });
      expect(result.receipts).toHaveLength(0);
      expect(result.pendingRuns).toHaveLength(1);
      expect(result.pendingRuns[0]).toMatchObject({
        id: runId,
        name: "sourcey",
        status: "paused",
        kind: "graph_execution",
        selectedRunner: "agent-step",
        stepIds: ["discover"],
        stepLabels: ["inspect repo"],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("inspectLocalRun returns a paused summary for paused runs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-paused-inspect-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runId = "gx_paused0000000000000000000000cd";

    try {
      await writePausedLedger(receiptDir, runId, "issue-to-pr");

      const result = await inspectLocalRun({ referenceId: runId, receiptDir });
      expect(result.kind).toBe("paused");
      if (result.kind !== "paused") return;
      expect(result.runId).toBe(runId);
      expect(result.summary.name).toBe("issue-to-pr");
      expect(result.summary.status).toBe("paused");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("listLocalHistory does not double-list runs that have terminal receipts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-paused-dedupe-"));
    const receiptDir = path.join(tempDir, "receipts");

    try {
      const result = await listLocalHistory({ receiptDir });
      expect(result.receipts).toHaveLength(0);
      expect(result.pendingRuns).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
