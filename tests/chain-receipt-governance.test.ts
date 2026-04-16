import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLocalChain, type Caller } from "../packages/runner-local/src/index.js";

const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("chain receipt governance metadata", () => {
  it("records runner and allowed scope admission in chain and step receipts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-receipt-governance-"));
    const receiptDir = path.join(tempDir, "receipts");

    try {
      await writeGovernedSkill(path.join(tempDir, "skills", "governed-echo"));
      const chainPath = path.join(tempDir, "chain.yaml");
      await writeFile(
        chainPath,
        `name: chain-receipt-governance
steps:
  - id: echo
    skill: ./skills/governed-echo
    runner: governed-echo-cli
    scopes:
      - repo:read
    inputs:
      message: scoped ok
`,
      );

      const result = await runLocalChain({
        chainPath,
        caller,
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        chainGrant: {
          grant_id: "grant_repo",
          scopes: ["repo:*"],
        },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(result.receipt.steps[0]).toMatchObject({
        runner: "governed-echo-cli",
        governance: {
          scope_admission: {
            status: "allow",
            requested_scopes: ["repo:read"],
            granted_scopes: ["repo:*"],
            grant_id: "grant_repo",
          },
        },
      });

      const stepReceipt = JSON.parse(await readFile(path.join(receiptDir, `${result.steps[0].receiptId}.json`), "utf8")) as {
        metadata?: Record<string, unknown>;
      };
      expect(stepReceipt.metadata).toMatchObject({
        chain_governance: {
          step_id: "echo",
          selected_runner: "governed-echo-cli",
          scope_admission: {
            status: "allow",
            requested_scopes: ["repo:read"],
            granted_scopes: ["repo:*"],
            grant_id: "grant_repo",
          },
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records denied scope admission in the chain receipt without a step receipt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-receipt-denied-"));
    const receiptDir = path.join(tempDir, "receipts");

    try {
      await writeGovernedSkill(path.join(tempDir, "skills", "governed-echo"));
      const chainPath = path.join(tempDir, "chain.yaml");
      await writeFile(
        chainPath,
        `name: chain-receipt-denied
steps:
  - id: deploy
    skill: ./skills/governed-echo
    runner: governed-echo-cli
    scopes:
      - deployments:write
    inputs:
      message: denied
`,
      );

      const result = await runLocalChain({
        chainPath,
        caller,
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        chainGrant: {
          grant_id: "grant_repo",
          scopes: ["repo:read"],
        },
      });

      expect(result.status).toBe("policy_denied");
      if (result.status !== "policy_denied") {
        return;
      }

      expect(result.receipt).toMatchObject({
        status: "failure",
        steps: [
          {
            step_id: "deploy",
            runner: "governed-echo-cli",
            status: "failure",
            receipt_id: undefined,
            governance: {
              scope_admission: {
                status: "deny",
                requested_scopes: ["deployments:write"],
                granted_scopes: ["repo:read"],
                grant_id: "grant_repo",
                reasons: ["step 'deploy' requested scope(s) outside chain grant: deployments:write"],
              },
            },
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writeGovernedSkill(skillDir: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await mkdir(path.join(skillDir, ".runx"), { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: governed-echo
description: Portable governed echo.
---

Echo a message.
`,
  );
  const profileDocument = `skill: governed-echo
runners:
  governed-echo-cli:
    type: cli-tool
    command: node
    args:
      - -e
      - "process.stdout.write(process.env.RUNX_INPUT_MESSAGE || '')"
    inputs:
      message:
        type: string
        required: true
`;
  await writeFile(
    path.join(skillDir, ".runx/profile.json"),
    `${JSON.stringify(
      {
        schema_version: "runx.skill-profile.v1",
        skill: {
          name: "governed-echo",
          path: "SKILL.md",
          digest: "fixture-skill-digest",
        },
        profile: {
          document: profileDocument,
          digest: "fixture-profile-digest",
          runner_names: ["governed-echo-cli"],
        },
        origin: {
          source: "fixture",
        },
      },
      null,
      2,
    )}\n`,
  );
}
