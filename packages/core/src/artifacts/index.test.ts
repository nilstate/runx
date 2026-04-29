import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendLedgerEntries,
  appendPreparedLedgerEntries,
  createArtifactEnvelope,
  createRunEventEntry,
  inspectLedger,
  prepareLedgerAppend,
  readLedgerEntries,
  resolveLedgerPath,
} from "./index.js";

describe("ledger tamper evidence", () => {
  it("writes chained ledger records while preserving the artifact read model", async () => {
    await withReceiptDir("chained", async (receiptDir) => {
      const runId = "rx_chain00000000000000000000000a";
      const first = artifact(runId, "first");
      const second = artifact(runId, "second");

      await appendLedgerEntries({ receiptDir, runId, entries: [first] });
      await appendLedgerEntries({ receiptDir, runId, entries: [second] });

      const rawLines = (await readFile(resolveLedgerPath(receiptDir, runId), "utf8")).trim().split("\n");
      expect(rawLines).toHaveLength(2);
      expect(JSON.parse(rawLines[0] ?? "{}")).toMatchObject({
        schema_version: "runx.ledger.entry.v1",
        chain: {
          version: "runx.ledger.chain.v1",
          index: 0,
          previous_hash: null,
        },
        entry: {
          meta: {
            artifact_id: first.meta.artifact_id,
          },
        },
      });

      await expect(readLedgerEntries(receiptDir, runId)).resolves.toEqual([first, second]);
      await expect(inspectLedger(receiptDir, runId)).resolves.toMatchObject({
        verification: {
          status: "valid",
          entryCount: 2,
        },
      });
    });
  });

  it("rejects raw artifact envelopes as invalid ledger records", async () => {
    await withReceiptDir("raw-envelope", async (receiptDir) => {
      const runId = "rx_raw00000000000000000000000a";
      const entry = artifact(runId, "raw");
      await mkdir(path.dirname(resolveLedgerPath(receiptDir, runId)), { recursive: true });
      await writeFile(resolveLedgerPath(receiptDir, runId), `${JSON.stringify(entry)}\n`);

      await expect(readLedgerEntries(receiptDir, runId)).rejects.toThrow(`${resolveLedgerPath(receiptDir, runId)}:1`);
      await expect(inspectLedger(receiptDir, runId)).resolves.toMatchObject({
        verification: {
          status: "invalid",
        },
      });
    });
  });

  it("treats signed anchors as verified prefixes when later derived events append", async () => {
    await withReceiptDir("anchor-prefix", async (receiptDir) => {
      const runId = "rx_prefix000000000000000000000a";
      const anchored = await prepareLedgerAppend({
        receiptDir,
        runId,
        entries: [artifact(runId, "terminal")],
      });
      await appendPreparedLedgerEntries(anchored);
      await appendLedgerEntries({
        receiptDir,
        runId,
        entries: [artifact(runId, "post-receipt")],
      });

      await expect(inspectLedger(receiptDir, runId, anchored.anchor)).resolves.toMatchObject({
        verification: {
          status: "valid",
          entryCount: 2,
        },
      });
    });
  });

  it("rejects system ledger events for a different ledger run id", async () => {
    await withReceiptDir("wrong-run", async (receiptDir) => {
      await expect(appendLedgerEntries({
        receiptDir,
        runId: "rx_target000000000000000000000a",
        entries: [
          createRunEventEntry({
            runId: "rx_other0000000000000000000000a",
            producer: { skill: "ledger-test", runner: "vitest" },
            kind: "run_started",
            status: "started",
          }),
        ],
      })).rejects.toThrow("expected rx_target000000000000000000000a");
    });
  });

  it("detects chain-stripped entries when an anchor expects chained records", async () => {
    await withReceiptDir("chain-strip", async (receiptDir) => {
      const runId = "rx_strip0000000000000000000000a";
      const plan = await prepareLedgerAppend({
        receiptDir,
        runId,
        entries: [artifact(runId, "first"), artifact(runId, "second")],
      });
      await appendPreparedLedgerEntries(plan);

      const ledgerPath = resolveLedgerPath(receiptDir, runId);
      const strippedLines = (await readFile(ledgerPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.stringify((JSON.parse(line) as { entry: unknown }).entry));
      await writeFile(ledgerPath, `${strippedLines.join("\n")}\n`);

      const inspection = await inspectLedger(receiptDir, runId, plan.anchor);
      expect(inspection.verification.status).toBe("invalid");
      expect(inspection.verification.reason).toContain(`${ledgerPath}:1`);
    });
  });

  it("does not persist a broken chain under concurrent appends", async () => {
    await withReceiptDir("concurrent", async (receiptDir) => {
      const runId = "rx_concurrent00000000000000000a";
      await Promise.allSettled([
        appendLedgerEntries({ receiptDir, runId, entries: [artifact(runId, "left")] }),
        appendLedgerEntries({ receiptDir, runId, entries: [artifact(runId, "right")] }),
      ]);

      await expect(inspectLedger(receiptDir, runId)).resolves.toMatchObject({
        verification: { status: "valid" },
      });
    });
  });

  it("recovers stale append lock markers before writing", async () => {
    await withReceiptDir("stale-lock", async (receiptDir) => {
      const runId = "rx_stalelock00000000000000000a";
      const ledgerPath = resolveLedgerPath(receiptDir, runId);
      await mkdir(path.dirname(ledgerPath), { recursive: true });
      await writeFile(`${ledgerPath}.lock`, "999999999\n");

      await appendLedgerEntries({ receiptDir, runId, entries: [artifact(runId, "after-stale-lock")] });

      await expect(readFile(`${ledgerPath}.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(inspectLedger(receiptDir, runId)).resolves.toMatchObject({
        verification: { status: "valid", entryCount: 1 },
      });
    });
  });

  it("rechecks empty prepared appends against the live ledger", async () => {
    await withReceiptDir("empty-recheck", async (receiptDir) => {
      const runId = "rx_emptyrecheck000000000000000a";
      await appendLedgerEntries({ receiptDir, runId, entries: [artifact(runId, "first")] });
      const plan = await prepareLedgerAppend({ receiptDir, runId, entries: [] });
      await appendLedgerEntries({ receiptDir, runId, entries: [artifact(runId, "second")] });

      await expect(appendPreparedLedgerEntries(plan)).rejects.toThrow("ledger changed while append was being prepared");
    });
  });

  it("detects modified and reordered chained entries", async () => {
    await withReceiptDir("tamper", async (receiptDir) => {
      const runId = "rx_tamper00000000000000000000a";
      await appendLedgerEntries({
        receiptDir,
        runId,
        entries: [artifact(runId, "first"), artifact(runId, "second"), artifact(runId, "third")],
      });
      const ledgerPath = resolveLedgerPath(receiptDir, runId);
      const originalLines = (await readFile(ledgerPath, "utf8")).trim().split("\n");

      const modified = JSON.parse(originalLines[1] ?? "{}") as {
        entry: { data: Record<string, unknown> };
      };
      modified.entry.data.label = "modified";
      await writeFile(ledgerPath, `${[originalLines[0], JSON.stringify(modified), originalLines[2]].join("\n")}\n`);
      await expect(inspectLedger(receiptDir, runId)).resolves.toMatchObject({
        verification: {
          status: "invalid",
          reason: "line 2 entry hash mismatch",
        },
      });
      await expect(readLedgerEntries(receiptDir, runId)).rejects.toThrow("line 2 entry hash mismatch");

      await writeFile(ledgerPath, `${[originalLines[1], originalLines[0], originalLines[2]].join("\n")}\n`);
      await expect(inspectLedger(receiptDir, runId)).resolves.toMatchObject({
        verification: {
          status: "invalid",
        },
      });
    });
  });
});

async function withReceiptDir<T>(label: string, fn: (receiptDir: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `runx-ledger-${label}-`));
  const receiptDir = path.join(tempDir, "receipts");
  try {
    return await fn(receiptDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function artifact(runId: string, label: string) {
  return createArtifactEnvelope({
    type: "test_artifact",
    data: { label },
    runId,
    producer: { skill: "ledger-test", runner: "vitest" },
    createdAt: `2026-04-29T00:00:0${label.length % 10}.000Z`,
  });
}
