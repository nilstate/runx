import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildLocalReceipt, buildLocalGraphReceipt, loadOrCreateLocalKey } from "@runxhq/core/receipts";
import { listLocalHistory } from "@runxhq/runtime-local";

describe("receipt writer enforces non-empty identity", () => {
  it("buildLocalReceipt throws when skillName is empty", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-receipt-assert-"));
    try {
      const keyPair = await loadOrCreateLocalKey(tempDir);
      expect(() =>
        buildLocalReceipt(
          {
            skillName: "",
            sourceType: "cli-tool",
            startedAt: "2026-04-28T00:00:00Z",
            completedAt: "2026-04-28T00:00:01Z",
            inputs: {},
            stdout: "",
            stderr: "",
            execution: { status: "success", durationMs: 1000, exitCode: 0, signal: null },
            contextFrom: [],
          },
          keyPair,
        ),
      ).toThrow(/Receipt skillName must be a non-empty string/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("buildLocalReceipt throws when skillName is null", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-receipt-assert-"));
    try {
      const keyPair = await loadOrCreateLocalKey(tempDir);
      expect(() =>
        buildLocalReceipt(
          {
            skillName: null as unknown as string,
            sourceType: "cli-tool",
            startedAt: "2026-04-28T00:00:00Z",
            completedAt: "2026-04-28T00:00:01Z",
            inputs: {},
            stdout: "",
            stderr: "",
            execution: { status: "success", durationMs: 1000, exitCode: 0, signal: null },
            contextFrom: [],
          },
          keyPair,
        ),
      ).toThrow(/Receipt skillName must be a non-empty string/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("buildLocalGraphReceipt throws when graphName is empty", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-receipt-assert-"));
    try {
      const keyPair = await loadOrCreateLocalKey(tempDir);
      expect(() =>
        buildLocalGraphReceipt(
          {
            graphId: "gx_test",
            graphName: "",
            status: "success",
            startedAt: "2026-04-28T00:00:00Z",
            completedAt: "2026-04-28T00:00:01Z",
            durationMs: 1000,
            inputs: {},
            output: "",
            steps: [],
          },
          keyPair,
        ),
      ).toThrow(/Receipt graphName must be a non-empty string/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("history summarizer falls back when receipt identity is missing", () => {
  it("returns receipt.id as name for a skill_execution receipt with skill_name: null", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-history-malformed-"));
    const receiptDir = path.join(tempDir, "receipts");
    await mkdir(receiptDir, { recursive: true });

    const malformedId = "rx_malformedskill0000000000000001";
    const malformed = {
      schema_version: "runx.receipt.v1",
      id: malformedId,
      kind: "skill_execution",
      issuer: { type: "local", kid: "test", public_key_sha256: "f".repeat(64) },
      skill_name: null,
      source_type: null,
      status: "failure",
      started_at: "2026-04-22T12:51:13.036Z",
      completed_at: "2026-04-22T12:51:13.040Z",
      duration_ms: 4,
      input_hash: "a".repeat(64),
      output_hash: "b".repeat(64),
      context_from: [],
      disposition: "completed",
      outcome_state: "complete",
      execution: { exit_code: 1, signal: null },
      signature: "z".repeat(64),
    };

    try {
      await writeFile(path.join(receiptDir, `${malformedId}.json`), JSON.stringify(malformed));

      const result = await listLocalHistory({ receiptDir });
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]?.name).toBe(malformedId);
      expect(result.receipts[0]?.id).toBe(malformedId);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns receipt.id as name for a graph_execution receipt missing graph_name", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-history-malformed-graph-"));
    const receiptDir = path.join(tempDir, "receipts");
    await mkdir(receiptDir, { recursive: true });

    const malformedId = "rx_malformedgraph0000000000000001";
    const malformed = {
      schema_version: "runx.receipt.v1",
      id: malformedId,
      kind: "graph_execution",
      issuer: { type: "local", kid: "test", public_key_sha256: "f".repeat(64) },
      status: "failure",
      started_at: "2026-04-22T12:51:10.440Z",
      completed_at: "2026-04-22T12:51:14.359Z",
      duration_ms: 3919,
      input_hash: "a".repeat(64),
      output_hash: "b".repeat(64),
      disposition: "completed",
      outcome_state: "complete",
      steps: [],
      signature: "z".repeat(64),
    };

    try {
      await writeFile(path.join(receiptDir, `${malformedId}.json`), JSON.stringify(malformed));

      const result = await listLocalHistory({ receiptDir });
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]?.name).toBe(malformedId);
      expect(result.receipts[0]?.kind).toBe("graph_execution");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
