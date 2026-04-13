import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

describe("approval receipt metadata", () => {
  it("records approved gates in successful skill receipts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-approval-receipt-ok-"));
    const receiptDir = path.join(tempDir, "receipts");

    try {
      const skillPath = await writeUnrestrictedSkill(tempDir, "approval-receipt-ok");
      const result = await runLocalSkill({
        skillPath,
        caller: approvalCaller(true),
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      const receipt = JSON.parse(await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8"));
      expect(receipt.metadata).toMatchObject({
        approval: {
          gate_id: "sandbox.approval-receipt-ok.unrestricted-local-dev",
          gate_type: "sandbox",
          decision: "approved",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records denied gates in failure receipts without executing the skill", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-approval-receipt-deny-"));
    const receiptDir = path.join(tempDir, "receipts");

    try {
      const skillPath = await writeUnrestrictedSkill(tempDir, "approval-receipt-deny");
      const result = await runLocalSkill({
        skillPath,
        caller: approvalCaller(false),
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("policy_denied");
      if (result.status !== "policy_denied") {
        return;
      }
      expect(result.receipt).toBeDefined();
      const receipt = JSON.parse(await readFile(path.join(receiptDir, `${result.receipt?.id}.json`), "utf8"));
      expect(receipt.status).toBe("failure");
      expect(receipt.output_hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
      expect(receipt.metadata).toMatchObject({
        approval: {
          gate_id: "sandbox.approval-receipt-deny.unrestricted-local-dev",
          gate_type: "sandbox",
          decision: "denied",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function approvalCaller(approved: boolean): Caller {
  return {
    resolve: async (request) =>
      request.kind === "approval"
        ? {
            actor: "human",
            payload: approved,
          }
        : undefined,
    report: () => undefined,
  };
}

async function writeUnrestrictedSkill(tempDir: string, name: string): Promise<string> {
  const skillDir = path.join(tempDir, name);
  const skillPath = path.join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    skillPath,
    `---
name: ${name}
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "process.stdout.write('approved')"
  sandbox:
    profile: unrestricted-local-dev
---
Unrestricted fixture.
`,
  );
  return skillPath;
}
