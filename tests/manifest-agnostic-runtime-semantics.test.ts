import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { latestVerifiedReceiptOutcomeResolution, writeReceiptOutcomeResolution } from "../packages/receipts/src/index.js";
import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("manifest-agnostic runtime semantics", () => {
  it("supports direct caller semantics and append-only outcome resolution", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-direct-semantics-"));
    const receiptDir = path.join(tempDir, "receipts");

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("fixtures/skills/echo"),
        inputs: {
          message: "x".repeat(512),
        },
        caller,
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        executionSemantics: {
          disposition: "observing",
          outcome_state: "pending",
          input_context: {
            capture: true,
            max_bytes: 64,
          },
          surface_refs: [{ type: "issue", uri: "github://owner/repo/issues/99" }],
        },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success" || result.receipt.kind !== "skill_execution") {
        return;
      }

      const receiptPath = path.join(receiptDir, `${result.receipt.id}.json`);
      const before = await readFile(receiptPath, "utf8");

      expect(result.receipt.disposition).toBe("observing");
      expect(result.receipt.outcome_state).toBe("pending");
      expect(result.receipt.input_context).toMatchObject({
        truncated: false,
        max_bytes: 64,
        snapshot: { message: "[redacted]" },
      });

      await writeReceiptOutcomeResolution({
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        receiptId: result.receipt.id,
        outcomeState: "complete",
        source: "integration-test",
        outcome: {
          code: "confirmed",
          summary: "Outcome confirmed after execution.",
        },
      });

      const after = await readFile(receiptPath, "utf8");
      const latest = await latestVerifiedReceiptOutcomeResolution(receiptDir, result.receipt.id, path.join(tempDir, "home"));

      expect(after).toBe(before);
      expect(latest).toMatchObject({
        verification: { status: "verified" },
        resolution: {
          receipt_id: result.receipt.id,
          outcome_state: "complete",
          source: "integration-test",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lets a manifest project optional execution hints into the same runtime contract", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runprofiled-semantics-"));

    try {
      const skillDir = path.join(tempDir, "manifest-skill");
      const fixtureMarkdown = await readFile(path.resolve("fixtures/runtime-semantics/manifest-skill.md"), "utf8");
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), fixtureMarkdown);
      const result = await runLocalSkill({
        skillPath: skillDir,
        inputs: {
          message: "manifest-driven",
        },
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success" || result.receipt.kind !== "skill_execution") {
        return;
      }

      expect(result.receipt).toMatchObject({
        disposition: "observing",
        outcome_state: "pending",
        surface_refs: [{ type: "issue", uri: "github://owner/repo/issues/77" }],
      });
      expect(result.receipt.input_context).toMatchObject({
        source: "inputs",
        truncated: false,
      });
      expect(result.receipt.input_context?.snapshot).toEqual({ message: "[redacted]" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("converges manifest-driven and direct-caller semantics on the same receipt model", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-semantics-converge-"));

    try {
      const skillDir = path.join(tempDir, "manifest-skill");
      const fixtureMarkdown = await readFile(path.resolve("fixtures/runtime-semantics/manifest-skill.md"), "utf8");
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), fixtureMarkdown);

      const [manifestResult, directResult] = await Promise.all([
        runLocalSkill({
          skillPath: skillDir,
          inputs: { message: "same-shape" },
          caller,
          receiptDir: path.join(tempDir, "manifest-receipts"),
          runxHome: path.join(tempDir, "manifest-home"),
          env: process.env,
        }),
        runLocalSkill({
          skillPath: path.resolve("fixtures/skills/echo"),
          inputs: { message: "same-shape" },
          caller,
          receiptDir: path.join(tempDir, "direct-receipts"),
          runxHome: path.join(tempDir, "direct-home"),
          env: process.env,
          executionSemantics: {
            disposition: "observing",
            outcome_state: "pending",
            input_context: {
              capture: true,
              max_bytes: 128,
            },
            surface_refs: [{ type: "issue", uri: "github://owner/repo/issues/77" }],
          },
        }),
      ]);

      expect(manifestResult.status).toBe("success");
      expect(directResult.status).toBe("success");
      if (
        manifestResult.status !== "success" ||
        directResult.status !== "success" ||
        manifestResult.receipt.kind !== "skill_execution" ||
        directResult.receipt.kind !== "skill_execution"
      ) {
        return;
      }

      const summarize = (receipt: typeof manifestResult.receipt) => ({
        disposition: receipt.disposition,
        outcome_state: receipt.outcome_state,
        surface_refs: receipt.surface_refs,
        input_context: {
          source: receipt.input_context?.source,
          truncated: receipt.input_context?.truncated,
          snapshot: receipt.input_context?.snapshot,
        },
      });

      expect(summarize(manifestResult.receipt)).toEqual(summarize(directResult.receipt));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
