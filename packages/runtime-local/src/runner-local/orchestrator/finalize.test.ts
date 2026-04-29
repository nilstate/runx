import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { appendLedgerEntries, readLedgerEntries } from "@runxhq/core/artifacts";

import { finalizeRun, type FinalizeRunContext } from "./finalize.js";
import { buildGraphCompletedLedgerEntry } from "../graph-ledger.js";
import type { RunLocalGraphOptions } from "../index.js";

describe("finalizeRun ledger ordering", () => {
  it("commits the terminal ledger entry before graph receipt write failure", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-finalize-ledger-first-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");
    const graphId = "gx_finalize0000000000000000000a";

    try {
      await mkdir(path.join(receiptDir, `${graphId}.json`), { recursive: true });

      await expect(finalizeRun(
        minimalRunContext({ graphId, receiptDir }),
        minimalGraphOptions({ runxHome }),
      )).rejects.toThrow();

      const entries = await readLedgerEntries(receiptDir, graphId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: "run_event",
        data: {
          kind: "graph_completed",
          status: "success",
          detail: {
            receipt_id: graphId,
          },
        },
      });
      expect((await stat(path.join(receiptDir, `${graphId}.json`))).isDirectory()).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not append a second terminal ledger entry when retrying after receipt write failure", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-finalize-idempotent-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");
    const graphId = "gx_idempotent0000000000000000a";

    try {
      await appendLedgerEntries({
        receiptDir,
        runId: graphId,
        entries: [
          buildGraphCompletedLedgerEntry({
            runId: graphId,
            topLevelSkillName: "finalize-order",
            receiptId: graphId,
            stepCount: 0,
            status: "success",
            createdAt: "2026-04-29T00:00:01.000Z",
          }),
        ],
      });

      const result = await finalizeRun(
        minimalRunContext({ graphId, receiptDir }),
        minimalGraphOptions({ runxHome }),
      );

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        throw new Error(`Expected success result, received ${result.status}`);
      }
      expect(result.receipt.id).toBe(graphId);
      const terminalEntries = (await readLedgerEntries(receiptDir, graphId)).filter((entry) =>
        entry.type === "run_event" && entry.data.kind === "graph_completed",
      );
      expect(terminalEntries).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function minimalGraphOptions(options: { readonly runxHome: string }): RunLocalGraphOptions {
  return {
    inputs: {},
    runxHome: options.runxHome,
    caller: {
      resolve: async () => undefined,
      report: async () => undefined,
    },
  };
}

function minimalRunContext(options: {
  readonly graphId: string;
  readonly receiptDir: string;
}): FinalizeRunContext {
  const startedAt = "2026-04-29T00:00:00.000Z";
  return {
    graph: {
      name: "finalize-order",
      owner: "runx",
      steps: [],
      fanoutGroups: {},
      raw: {
        document: {},
      },
    },
    graphId: options.graphId,
    receiptDir: options.receiptDir,
    state: {
      graphId: options.graphId,
      status: "succeeded",
      steps: [],
    },
    stepRuns: [],
    syncPoints: [],
    startedAt,
    startedAtMs: Date.parse(startedAt),
    finalOutput: "ok",
    finalError: undefined,
    executionSemantics: {
      disposition: "completed",
      outcomeState: "complete",
    },
    inheritedReceiptMetadata: undefined,
    terminalReceiptMetadata: undefined,
    involvedAgentMediatedWork: false,
  };
}
