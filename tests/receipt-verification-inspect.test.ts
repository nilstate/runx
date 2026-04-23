import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { writeLocalReceipt } from "@runxhq/core/receipts";
import { inspectLocalReceipt, listLocalHistory } from "@runxhq/core/runner-local";

describe("receipt verification for inspect/history", () => {
  it("marks locally signed receipts as verified", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-receipt-verify-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const receipt = await writeFixtureReceipt(receiptDir, runxHome);

      await expect(inspectLocalReceipt({ receiptDir, runxHome, receiptId: receipt.id })).resolves.toMatchObject({
        verification: { status: "verified" },
        summary: {
          id: receipt.id,
          verification: { status: "verified" },
        },
      });
      await expect(listLocalHistory({ receiptDir, runxHome })).resolves.toMatchObject({
        receipts: [
          {
            id: receipt.id,
            verification: { status: "verified" },
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks tampered receipts as invalid", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-receipt-tamper-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const receipt = await writeFixtureReceipt(receiptDir, runxHome);
      const receiptPath = path.join(receiptDir, `${receipt.id}.json`);
      const contents = await readFile(receiptPath, "utf8");
      await writeFile(receiptPath, contents.replace('"status": "success"', '"status": "failure"'));

      await expect(inspectLocalReceipt({ receiptDir, runxHome, receiptId: receipt.id })).resolves.toMatchObject({
        receipt: {
          id: receipt.id,
          status: "failure",
        },
        verification: { status: "invalid", reason: "signature_mismatch" },
        summary: {
          verification: { status: "invalid", reason: "signature_mismatch" },
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks receipts as unverified when local key material is unavailable", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-receipt-unverified-"));
    const receiptDir = path.join(tempDir, "receipts");

    try {
      const receipt = await writeFixtureReceipt(receiptDir, path.join(tempDir, "signing-home"));

      await expect(
        inspectLocalReceipt({
          receiptDir,
          runxHome: path.join(tempDir, "empty-home"),
          receiptId: receipt.id,
        }),
      ).resolves.toMatchObject({
        receipt: { id: receipt.id },
        verification: { status: "unverified", reason: "local_public_key_missing" },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writeFixtureReceipt(receiptDir: string, runxHome: string) {
  return await writeLocalReceipt({
    receiptDir,
    runxHome,
    skillName: "echo",
    sourceType: "cli-tool",
    inputs: { message: "hi" },
    stdout: "ok",
    stderr: "",
    execution: {
      status: "success",
      exitCode: 0,
      signal: null,
      durationMs: 1,
    },
    startedAt: "2026-04-10T00:00:00Z",
    completedAt: "2026-04-10T00:00:01Z",
  });
}
