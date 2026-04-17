import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createArtifactEnvelope, appendJournalEntries } from "../../artifacts/src/index.js";
import { runCli } from "./index.js";
import { writeLocalReceipt, writeReceiptOutcomeResolution } from "../../receipts/src/index.js";
import { runLocalSkill, type Caller } from "../../runner-local/src/index.js";
import type { SkillAdapter } from "../../executor/src/index.js";
import { TRAINING_SCHEMA_REFS } from "./trainable-receipts.js";

const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("trainable receipts export", () => {
  it("publishes the canonical trainable receipt row schema ref", () => {
    expect(TRAINING_SCHEMA_REFS.trainable_receipt_row).toBe("https://runx.ai/spec/training/trainable-receipt-row.schema.json");
  });

  it("streams filtered JSONL records with outcome resolution, journal entries, and prompt provenance without mutating receipts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-trainable-receipts-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const completeReceipt = await writeLocalReceipt({
        receiptDir,
        runxHome,
        skillName: "github-triage",
        sourceType: "cli-tool",
        inputs: { issue: 123 },
        stdout: "triaged",
        stderr: "",
        execution: {
          status: "success",
          exitCode: 0,
          signal: null,
          durationMs: 5,
          metadata: {
            runner: {
              provider: "openai",
              model: "gpt-test",
              prompt_version: "triage-v1",
            },
          },
        },
        startedAt: "2026-04-10T00:00:00Z",
        completedAt: "2026-04-10T00:00:05Z",
        outcomeState: "pending",
        disposition: "observing",
      });
      const completeReceiptPath = path.join(receiptDir, `${completeReceipt.id}.json`);
      const before = await readFile(completeReceiptPath, "utf8");

      await writeReceiptOutcomeResolution({
        receiptDir,
        runxHome,
        receiptId: completeReceipt.id,
        outcomeState: "complete",
        source: "integration-test",
        outcome: {
          code: "resolved",
          summary: "Issue was triaged successfully.",
        },
      });

      await appendJournalEntries({
        receiptDir,
        runId: completeReceipt.id,
        entries: [
          createArtifactEnvelope({
            type: "run_event",
            data: { kind: "triage", status: "success" },
            runId: completeReceipt.id,
            producer: { skill: "github-triage", runner: "agent" },
          }),
        ],
      });

      await writeLocalReceipt({
        receiptDir,
        runxHome,
        skillName: "other-skill",
        sourceType: "agent",
        inputs: { issue: 999 },
        stdout: "ignored",
        stderr: "",
        execution: {
          status: "success",
          exitCode: 0,
          signal: null,
          durationMs: 5,
        },
        startedAt: "2026-04-11T00:00:00Z",
        completedAt: "2026-04-11T00:00:05Z",
        outcomeState: "pending",
        disposition: "observing",
      });

      const stdout = createMemoryStream();
      const stderr = createMemoryStream();
      const exitCode = await runCli(
        [
          "export-receipts",
          "--trainable",
          "--receipt-dir",
          receiptDir,
          "--since",
          "2026-04-09T00:00:00Z",
          "--status",
          "complete",
          "--source",
          "cli-tool",
        ],
        { stdin: process.stdin, stdout, stderr },
        {
          ...process.env,
          RUNX_HOME: runxHome,
          RUNX_CWD: process.cwd(),
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr.contents()).toBe("");

      const rows = stdout.contents().trim().split("\n").map((line) => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "runx.trainable-receipt-row.v1",
        receipt_id: completeReceipt.id,
        receipt_kind: "skill_execution",
        skill_name: "github-triage",
        chain_name: null,
        owner: null,
        source_type: "cli-tool",
        status: "success",
        disposition: "observing",
        receipt: {
          id: completeReceipt.id,
          kind: "skill_execution",
          subject: {
            skill_name: "github-triage",
            source_type: "cli-tool",
          },
        },
        receipt_verification: { status: "verified" },
        effective_outcome_state: "complete",
        input_context: null,
        surface_refs: [],
        evidence_refs: [],
        context_from: [],
        artifact_ids: [],
        latest_outcome_resolution: {
          verification: { status: "verified" },
          resolution: {
            receipt_id: completeReceipt.id,
            outcome_state: "complete",
          },
        },
        journal_entries: [
          {
            type: "run_event",
          },
        ],
        runner_provenance: {
          provider: "openai",
          model: "gpt-test",
          prompt_version: "triage-v1",
        },
      });
      expect(typeof rows[0].exported_at).toBe("string");

      const after = await readFile(completeReceiptPath, "utf8");
      expect(after).toBe(before);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves prompt_version from adapter runner metadata into the immutable receipt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-trainable-receipt-metadata-"));
    const adapter: SkillAdapter = {
      type: "agent",
      invoke: async () => ({
        status: "success",
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 1,
        metadata: {
          runner: {
            provider: "openai",
            model: "gpt-test",
            prompt_version: "prompt-v1",
          },
        },
      }),
    };

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/portable"),
        caller,
        adapters: [adapter],
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success" || result.receipt.kind !== "skill_execution") {
        return;
      }

      expect(result.receipt.metadata).toMatchObject({
        runner: {
          provider: "openai",
          model: "gpt-test",
          prompt_version: "prompt-v1",
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
