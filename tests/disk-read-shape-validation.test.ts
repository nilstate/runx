import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendLedgerEntries,
  createRunEventEntry,
  readLedgerEntries,
  resolveLedgerPath,
} from "./ledger-fixtures.js";
const validArtifactEnvelope = {
  type: "run_event",
  version: "1",
  data: { event: "started" },
  meta: {
    artifact_id: "art_abc",
    run_id: "run_def",
    step_id: null,
    producer: { skill: "work-plan", runner: "work-plan-agent" },
    created_at: "2026-04-28T07:00:00Z",
    hash: "sha256:abc",
    size_bytes: 12,
    parent_artifact_id: null,
    receipt_id: null,
    redacted: false,
  },
};

describe("readLedgerEntries validates each line", () => {
  it("rejects a malformed ledger line and surfaces the path with line number", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-ledger-shape-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runId = "run_test_validate_ledger";
    const ledgerPath = resolveLedgerPath(receiptDir, runId);
    try {
      await appendValidLedgerEntry(receiptDir, runId);
      const existing = await readFile(ledgerPath, "utf8");
      await writeFile(ledgerPath, `${existing}${JSON.stringify({ ...validArtifactEnvelope, version: "2" })}\n`);
      await expect(readLedgerEntries(receiptDir, runId)).rejects.toThrow(`${ledgerPath}:2`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid JSON on a ledger line with line number", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-ledger-badjson-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runId = "run_test_badjson_ledger";
    const ledgerPath = resolveLedgerPath(receiptDir, runId);
    try {
      await appendValidLedgerEntry(receiptDir, runId);
      const existing = await readFile(ledgerPath, "utf8");
      await writeFile(ledgerPath, `${existing}{ this is not json\n`);
      await expect(readLedgerEntries(receiptDir, runId)).rejects.toThrow(`${ledgerPath}:2 is not valid JSON`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function appendValidLedgerEntry(receiptDir: string, runId: string): Promise<void> {
  await appendLedgerEntries({
    receiptDir,
    runId,
    entries: [
      createRunEventEntry({
        runId,
        producer: { skill: "work-plan", runner: "work-plan-agent" },
        kind: "run_started",
        status: "started",
        createdAt: "2026-04-28T07:00:00Z",
      }),
    ],
  });
}
