import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendLedgerEntries,
  createRunEventEntry,
  readLedgerEntries,
  resolveLedgerPath,
} from "@runxhq/core/artifacts";
import { readVerifiedLocalReceipt } from "@runxhq/core/receipts";

async function withReceiptDir<T>(label: string, fn: (receiptDir: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `runx-disk-read-${label}-`));
  const receiptDir = path.join(tempDir, "receipts");
  await mkdir(receiptDir, { recursive: true });
  try {
    return await fn(receiptDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const validReceipt = {
  schema_version: "runx.receipt.v1",
  id: "rx_validreceipt0000000000000000a",
  kind: "skill_execution",
  issuer: { type: "local", kid: "local_test", public_key_sha256: "deadbeef" },
  skill_name: "evolve",
  source_type: "graph",
  status: "success",
  duration_ms: 12,
  input_hash: "sha256:in",
  output_hash: "sha256:out",
  context_from: [],
  execution: { exit_code: 0, signal: null },
  signature: { alg: "Ed25519", value: "AAA" },
};

describe("disk-read shape validation surfaces corruption clearly", () => {
  it("readVerifiedLocalReceipt throws a path-prefixed error on null receipt content", async () => {
    await withReceiptDir("null", async (receiptDir) => {
      const id = "rx_nullreceipt00000000000000000a";
      const receiptPath = path.join(receiptDir, `${id}.json`);
      await writeFile(receiptPath, "null");
      await expect(readVerifiedLocalReceipt(receiptDir, id)).rejects.toThrow(/must match/);
      await expect(readVerifiedLocalReceipt(receiptDir, id)).rejects.toThrow(receiptPath);
    });
  });

  it("readVerifiedLocalReceipt throws on missing required signature", async () => {
    await withReceiptDir("nosig", async (receiptDir) => {
      const id = "rx_nosig00000000000000000000000a";
      const { signature: _drop, ...withoutSignature } = validReceipt;
      const receiptPath = path.join(receiptDir, `${id}.json`);
      await writeFile(receiptPath, JSON.stringify({ ...withoutSignature, id }));
      await expect(readVerifiedLocalReceipt(receiptDir, id)).rejects.toThrow(receiptPath);
    });
  });

  it("readVerifiedLocalReceipt throws on a wrong-typed required field", async () => {
    await withReceiptDir("wrongtype", async (receiptDir) => {
      const id = "rx_wrongtype0000000000000000000a";
      const receiptPath = path.join(receiptDir, `${id}.json`);
      await writeFile(receiptPath, JSON.stringify({ ...validReceipt, id, duration_ms: "not-a-number" }));
      await expect(readVerifiedLocalReceipt(receiptDir, id)).rejects.toThrow(receiptPath);
    });
  });

  it("readVerifiedLocalReceipt throws on an unknown schema_version (cross-version skew)", async () => {
    await withReceiptDir("oldversion", async (receiptDir) => {
      const id = "rx_oldversion000000000000000000a";
      const receiptPath = path.join(receiptDir, `${id}.json`);
      await writeFile(receiptPath, JSON.stringify({ ...validReceipt, id, schema_version: "runx.receipt.v0" }));
      await expect(readVerifiedLocalReceipt(receiptDir, id)).rejects.toThrow(receiptPath);
    });
  });

  it("readVerifiedLocalReceipt throws on invalid JSON with a clear message", async () => {
    await withReceiptDir("badjson", async (receiptDir) => {
      const id = "rx_badjson000000000000000000000a";
      const receiptPath = path.join(receiptDir, `${id}.json`);
      await writeFile(receiptPath, "{ this is not json");
      await expect(readVerifiedLocalReceipt(receiptDir, id)).rejects.toThrow(/is not valid JSON/);
      await expect(readVerifiedLocalReceipt(receiptDir, id)).rejects.toThrow(receiptPath);
    });
  });
});

const validArtifactEnvelope = {
  type: "run_event",
  version: "1",
  data: { event: "started" },
  meta: {
    artifact_id: "art_abc",
    run_id: "run_def",
    step_id: null,
    producer: { skill: "evolve", runner: "evolve" },
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
        producer: { skill: "evolve", runner: "evolve" },
        kind: "run_started",
        status: "started",
        createdAt: "2026-04-28T07:00:00Z",
      }),
    ],
  });
}
