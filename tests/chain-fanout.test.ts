import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { createDefaultSkillAdapters } from "@runxhq/adapters";
import { inspectLocalGraph, runLocalGraph, type Caller } from "@runxhq/core/runner-local";

const nonInteractiveCaller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};
const adapters = createDefaultSkillAdapters();

describe("local fanout chain runner", () => {
  it("runs a fanout group with all-success sync policy", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-fanout-all-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const result = await runLocalGraph({
        graphPath: path.resolve("fixtures/chains/fanout/all.yaml"),
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: process.env,
        adapters,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(result.steps.map((step) => [step.stepId, step.status, step.fanoutGroup])).toEqual([
        ["market", "success", "advisors"],
        ["risk", "success", "advisors"],
        ["finance", "success", "advisors"],
        ["synthesize", "success", undefined],
      ]);
      expect(result.steps[3].stdout).toBe("approved");
      expect(result.receipt.sync_points).toEqual([
        expect.objectContaining({
          group_id: "advisors",
          strategy: "all",
          decision: "proceed",
          rule_fired: "all.min_success",
          branch_count: 3,
          success_count: 3,
          failure_count: 0,
          required_successes: 3,
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("executes three one-second fanout branches concurrently", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-fanout-parallel-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");
    const graphPath = path.join(tempDir, "parallel.yaml");

    try {
      await Promise.all([
        writeSleepSkill(path.join(tempDir, "market"), "market"),
        writeSleepSkill(path.join(tempDir, "risk"), "risk"),
        writeSleepSkill(path.join(tempDir, "finance"), "finance"),
      ]);
      await writeFile(
        graphPath,
        `name: timed-fanout
owner: runx
fanout:
  groups:
    advisors:
      strategy: all
      on_branch_failure: halt
steps:
  - id: market
    mode: fanout
    fanout_group: advisors
    skill: ./market
  - id: risk
    mode: fanout
    fanout_group: advisors
    skill: ./risk
  - id: finance
    mode: fanout
    fanout_group: advisors
    skill: ./finance
`,
      );

      const started = performance.now();
      const result = await runLocalGraph({
        graphPath,
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: process.env,
        adapters,
      });
      const durationMs = performance.now() - started;

      expect(result.status).toBe("success");
      expect(durationMs).toBeLessThan(2000);
      if (result.status !== "success") {
        return;
      }
      expect(result.steps.map((step) => step.stepId)).toEqual(["market", "risk", "finance"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs a fanout group with quorum sync and linked branch receipts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-fanout-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");

    try {
      const result = await runLocalGraph({
        graphPath: path.resolve("fixtures/chains/fanout/chain.yaml"),
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: process.env,
        adapters,
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(result.steps.map((step) => [step.stepId, step.status, step.fanoutGroup])).toEqual([
        ["market", "success", "advisors"],
        ["risk", "success", "advisors"],
        ["finance", "failure", "advisors"],
        ["synthesize", "success", undefined],
      ]);
      expect(result.steps.slice(0, 3).map((step) => step.parentReceipt)).toEqual([undefined, undefined, undefined]);
      expect(result.steps[3].stdout).toBe("go");
      expect(result.receipt.steps.slice(0, 3).map((step) => step.fanout_group)).toEqual([
        "advisors",
        "advisors",
        "advisors",
      ]);
      expect(result.receipt.sync_points).toEqual([
        expect.objectContaining({
          group_id: "advisors",
          strategy: "quorum",
          decision: "proceed",
          rule_fired: "quorum.min_success",
          branch_count: 3,
          success_count: 2,
          failure_count: 1,
          required_successes: 2,
          branch_receipts: result.steps.slice(0, 3).map((step) => step.receiptId),
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("pauses and resumes deterministically when a structured threshold gate fires", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-fanout-threshold-"));
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");
    const graphPath = path.resolve("fixtures/chains/fanout/threshold.yaml");
    const approvingCaller: Caller = {
      resolve: async (request) => request.kind === "approval" ? { actor: "human", payload: true } : undefined,
      report: () => undefined,
    };

    try {
      const result = await runLocalGraph({
        graphPath,
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: process.env,
        adapters,
      });

      expect(result.status).toBe("needs_resolution");
      if (result.status !== "needs_resolution") {
        return;
      }
      expect(result.state.status).toBe("paused");

      expect(result.requests).toEqual([
        expect.objectContaining({
          id: "fanout.advisors.threshold.risk.risk_score.above",
          kind: "approval",
          gate: expect.objectContaining({
            type: "fanout-gate",
            reason: "risk.risk_score=0.91 exceeded 0.8",
          }),
        }),
      ]);

      const resumed = await runLocalGraph({
        graphPath,
        caller: approvingCaller,
        receiptDir,
        runxHome,
        env: process.env,
        adapters,
        resumeFromRunId: result.runId,
      });
      expect(resumed.status).toBe("success");
      if (resumed.status !== "success") {
        return;
      }
      expect(resumed.steps.map((step) => step.stepId)).toEqual(["market", "risk", "synthesize"]);
      expect(resumed.steps.slice(0, 2).map((step) => step.fanoutGroup)).toEqual(["advisors", "advisors"]);
      expect(resumed.output).toBe("go");
      expect(resumed.receipt.sync_points).toEqual([
        expect.objectContaining({
          group_id: "advisors",
          decision: "pause",
          rule_fired: "threshold.risk.risk_score.above",
          reason: "risk.risk_score=0.91 exceeded 0.8",
          branch_receipts: resumed.steps.slice(0, 2).map((step) => step.receiptId),
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("escalates structured fanout conflicts through a resolution gate", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-fanout-escalate-"));
    const graphPath = path.join(tempDir, "graph.yaml");
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");
    const jsonSkillPath = path.resolve("fixtures/skills/json-output");

    try {
      await writeFile(
        graphPath,
        `name: fanout-escalate
fanout:
  groups:
    advisors:
      strategy: all
      on_branch_failure: halt
      conflict_gates:
        - field: recommendation
          action: escalate
          steps:
            - market
            - risk
steps:
  - id: market
    mode: fanout
    fanout_group: advisors
    skill: ${jsonSkillPath}
    inputs:
      recommendation: ship
  - id: risk
    mode: fanout
    fanout_group: advisors
    skill: ${jsonSkillPath}
    inputs:
      recommendation: hold
`,
      );

      const result = await runLocalGraph({
        graphPath,
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: process.env,
        adapters,
      });

      expect(result.status).toBe("needs_resolution");
      if (result.status !== "needs_resolution") {
        return;
      }
      expect(result.state.status).toBe("escalated");
      expect(result.requests[0]).toMatchObject({
        id: "fanout.advisors.conflict.recommendation",
        kind: "approval",
        gate: {
          type: "fanout-escalation",
          reason: "fanout branches disagreed on structured field recommendation",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("applies graph transition policy before fanout branch execution", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-fanout-transition-policy-"));
    const graphPath = path.join(tempDir, "graph.yaml");
    const receiptDir = path.join(tempDir, "receipts");
    const runxHome = path.join(tempDir, "home");
    const jsonSkillPath = path.resolve("fixtures/skills/json-output");

    try {
      await writeFile(
        graphPath,
        `name: fanout-transition-policy
policy:
  transitions:
    - to: market
      field: seed.allowed
      equals: true
fanout:
  groups:
    advisors:
      strategy: all
      on_branch_failure: halt
steps:
  - id: seed
    skill: ${jsonSkillPath}
    inputs:
      allowed: false
  - id: market
    mode: fanout
    fanout_group: advisors
    skill: ${jsonSkillPath}
    inputs:
      recommendation: go
  - id: risk
    mode: fanout
    fanout_group: advisors
    skill: ${jsonSkillPath}
    inputs:
      risk_score: 0.2
`,
      );

      const result = await runLocalGraph({
        graphPath,
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome,
        env: process.env,
        adapters,
      });

      expect(result.status).toBe("policy_denied");
      if (result.status !== "policy_denied") {
        return;
      }
      expect(result.reasons).toEqual([
        "transition policy blocked step 'market': expected seed.allowed == true",
      ]);
      expect(result.receipt?.steps.map((step) => step.step_id)).toEqual(["seed", "market"]);
      expect(result.receipt?.steps[1]).toMatchObject({
        step_id: "market",
        status: "failure",
        disposition: "policy_denied",
        fanout_group: "advisors",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("exposes sync policy decisions through composite receipt inspection and the CLI shell", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-fanout-inspect-"));
    const receiptDir = path.join(tempDir, "receipts");
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    try {
      const result = await runLocalGraph({
        graphPath: path.resolve("fixtures/chains/fanout/chain.yaml"),
        caller: nonInteractiveCaller,
        receiptDir,
        runxHome: path.join(tempDir, "home"),
        env: process.env,
        adapters,
      });
      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      const inspection = await inspectLocalGraph({
        graphId: result.receipt.id,
        receiptDir,
        env: process.env,
      });
      expect(inspection.summary.syncPoints).toEqual([
        {
          groupId: "advisors",
          decision: "proceed",
          ruleFired: "quorum.min_success",
          reason: "2/3 branches succeeded; required 2",
        },
      ]);

      const inspectExit = await runCli(
        ["skill", "inspect", result.receipt.id, "--receipt-dir", receiptDir],
        { stdin: process.stdin, stdout, stderr },
        { ...process.env, RUNX_CWD: process.cwd(), RUNX_HOME: path.join(tempDir, "home") },
      );
      expect(inspectExit).toBe(0);
      expect(stdout.contents()).toContain("fanout-advisors");
      expect(stdout.contents()).toContain("graph_execution");
      expect(stdout.contents()).toContain(result.receipt.id);
      expect(stdout.contents()).toContain("verified");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string; clear: () => void } {
  let buffer = "";
  return {
    write: (chunk: string | Uint8Array) => {
      buffer += chunk.toString();
      return true;
    },
    contents: () => buffer,
    clear: () => {
      buffer = "";
    },
  } as NodeJS.WriteStream & { contents: () => string; clear: () => void };
}

async function writeSleepSkill(directory: string, label: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---
name: ${label}
description: Sleep for one second and then emit the skill label.
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "setTimeout(() => process.stdout.write('${label}'), 1000)"
  timeout_seconds: 5
inputs: {}
---

Emit ${label} after a one-second delay.
`,
  );
}
