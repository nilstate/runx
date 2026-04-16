import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { SkillAdapter } from "../packages/executor/src/index.js";
import { runLocalChain, type Caller } from "../packages/runner-local/src/index.js";

const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("chain runner governance", () => {
  it("selects a named cli-tool binding runner from a chain step", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-composite-runner-cli-"));

    try {
      const skillDir = path.join(tempDir, "skills", "package-echo");
      await writePackageEchoSkill(skillDir);
      const chainPath = path.join(tempDir, "chain.yaml");
      await writeFile(
        chainPath,
        `name: chain-runner-cli
steps:
  - id: echo
    skill: ./skills/package-echo
    runner: package-echo-cli
    inputs:
      message: selected runner
`,
      );

      const result = await runLocalChain({
        chainPath,
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps[0]).toMatchObject({
        runner: "package-echo-cli",
        stdout: "selected runner",
      });
      expect(result.receipt.steps[0]).toMatchObject({
        runner: "package-echo-cli",
        governance: {
          scope_admission: {
            status: "allow",
            requested_scopes: [],
            granted_scopes: ["*"],
            grant_id: "local-default",
          },
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("selects an A2A binding runner from a chain step", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-composite-runner-a2a-"));
    const chainPath = path.join(tempDir, "chain.yaml");

    try {
      await writeFile(
        chainPath,
        `name: chain-runner-a2a
steps:
  - id: echo
    skill: ${path.resolve("fixtures/skills/a2a-echo")}
    runner: fixture-a2a
    inputs:
      message: hi from chain
`,
      );

      const result = await runLocalChain({
        chainPath,
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }
      expect(result.steps[0]).toMatchObject({
        runner: "fixture-a2a",
        stdout: "hi from chain",
      });
      expect(result.receipt.steps[0]?.runner).toBe("fixture-a2a");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("denies step scopes that exceed the parent chain grant before execution", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-chain-scope-deny-"));
    const adapter = createCountingAdapter();

    try {
      const skillDir = path.join(tempDir, "skills", "package-echo");
      await writePackageEchoSkill(skillDir);
      const chainPath = path.join(tempDir, "chain.yaml");
      await writeFile(
        chainPath,
        `name: chain-scope-deny
steps:
  - id: deploy
    skill: ./skills/package-echo
    runner: package-echo-cli
    scopes:
      - deployments:write
    inputs:
      message: should not run
`,
      );

      const result = await runLocalChain({
        chainPath,
        caller,
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        adapters: [adapter],
        chainGrant: {
          grant_id: "grant_checks",
          scopes: ["checks:read"],
        },
      });

      expect(result.status).toBe("policy_denied");
      if (result.status !== "policy_denied") {
        return;
      }
      expect(result.reasons).toEqual(["step 'deploy' requested scope(s) outside chain grant: deployments:write"]);
      expect(adapter.callCount()).toBe(0);
      expect(result.receipt).toMatchObject({
        disposition: "policy_denied",
        outcome_state: "complete",
      });
      expect(result.receipt?.steps[0]).toMatchObject({
        step_id: "deploy",
        runner: "package-echo-cli",
        status: "failure",
        disposition: "policy_denied",
        outcome_state: "complete",
        governance: {
          scope_admission: {
            status: "deny",
            requested_scopes: ["deployments:write"],
            granted_scopes: ["checks:read"],
            grant_id: "grant_checks",
          },
        },
      });
      expect(result.receipt?.steps[0]?.receipt_id).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function writePackageEchoSkill(skillDir: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await mkdir(path.join(skillDir, ".runx"), { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: package-echo
description: Portable package echo.
---

Echo a message.
`,
  );
  const profileDocument = `skill: package-echo
runners:
  package-echo-cli:
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
          name: "package-echo",
          path: "SKILL.md",
          digest: "fixture-skill-digest",
        },
        profile: {
          document: profileDocument,
          digest: "fixture-profile-digest",
          runner_names: ["package-echo-cli"],
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

function createCountingAdapter(): SkillAdapter & { callCount: () => number } {
  let calls = 0;
  return {
    type: "cli-tool",
    callCount: () => calls,
    invoke: async () => {
      calls += 1;
      return {
        status: "success",
        stdout: "called",
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 1,
      };
    },
  };
}
