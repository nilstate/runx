import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { appendLedgerEntries, createArtifactEnvelope } from "@runxhq/core/artifacts";
import { writeLocalReceipt } from "@runxhq/core/receipts";
import { diffLocalRuns } from "@runxhq/runtime-local";
import { runCli } from "../packages/cli/src/index.js";

describe("run diff", () => {
  it("diffs receipt and ledger summaries without a second state store", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-run-diff-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      await seedReceipt({
        receiptDir,
        runxHome,
        receiptId: "rx_diff_left_0001",
        skillName: "sourcey",
        sourceType: "cli-tool",
        artifactType: "docs_site",
        runnerProvider: "openai",
      });
      await seedReceipt({
        receiptDir,
        runxHome,
        receiptId: "rx_diff_right_0001",
        skillName: "sourcey",
        sourceType: "agent-step",
        artifactType: "review_note",
        runnerProvider: "anthropic",
        approvalDecision: "approved",
        lineage: {
          kind: "rerun",
          source_run_id: "rx_diff_left_0001",
          source_receipt_id: "rx_diff_left_0001",
        },
      });

      await expect(diffLocalRuns({
        left: "rx_diff_left_0001",
        right: "rx_diff_right_0001",
        receiptDir,
        runxHome,
      })).resolves.toMatchObject({
        changed: true,
        fields: {
          source_type: {
            left: "cli-tool",
            right: "agent-step",
          },
          runner_provider: {
            left: "openai",
            right: "anthropic",
          },
          approval: {
            right: {
              decision: "approved",
            },
          },
          lineage: {
            right: {
              kind: "rerun",
              sourceRunId: "rx_diff_left_0001",
            },
          },
        },
        artifactTypes: {
          added: ["review_note"],
          removed: ["docs_site"],
        },
      });

      const stdout = createMemoryStream();
      const exit = await runCli(
        ["diff", "rx_diff_left_0001", "rx_diff_right_0001", "--receipt-dir", receiptDir, "--json"],
        { stdin: process.stdin, stdout, stderr: createMemoryStream() },
        {
          ...process.env,
          RUNX_CWD: process.cwd(),
          RUNX_HOME: runxHome,
        },
      );
      expect(exit).toBe(0);
      expect(JSON.parse(stdout.contents())).toMatchObject({
        status: "success",
        diff: {
          changed: true,
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function seedReceipt(options: {
  readonly receiptDir: string;
  readonly runxHome: string;
  readonly receiptId: string;
  readonly skillName: string;
  readonly sourceType: string;
  readonly artifactType: string;
  readonly runnerProvider: string;
  readonly approvalDecision?: "approved" | "denied";
  readonly lineage?: Readonly<Record<string, unknown>>;
}): Promise<void> {
  const artifact = createArtifactEnvelope({
    type: options.artifactType,
    data: { ok: true },
    runId: options.receiptId,
    producer: { skill: options.skillName, runner: options.sourceType },
  });
  await writeLocalReceipt({
    receiptId: options.receiptId,
    receiptDir: options.receiptDir,
    runxHome: options.runxHome,
    skillName: options.skillName,
    sourceType: options.sourceType,
    inputs: { project: "." },
    stdout: JSON.stringify({ ok: true }),
    stderr: "",
    execution: {
      status: "success",
      exitCode: 0,
      signal: null,
      durationMs: 3,
      metadata: {
        runner: {
          provider: options.runnerProvider,
        },
        approval: options.approvalDecision
          ? {
              gate_id: `${options.skillName}.approval`,
              gate_type: "human",
              decision: options.approvalDecision,
              reason: "reviewed",
            }
          : undefined,
        runx: options.lineage
          ? {
              lineage: options.lineage,
            }
          : undefined,
      },
    },
    artifactIds: [artifact.meta.artifact_id],
    startedAt: "2026-04-24T00:00:00Z",
    completedAt: "2026-04-24T00:00:01Z",
  });
  await appendLedgerEntries({
    receiptDir: options.receiptDir,
    runId: options.receiptId,
    entries: [artifact],
  });
}

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
