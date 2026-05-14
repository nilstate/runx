import { describe, expect, it } from "vitest";

import type { ArtifactEnvelope } from "@runxhq/core/artifacts";
import { createSequentialGraphState, type SequentialGraphState } from "@runxhq/core/state-machine";

import { hydrateGraphFromLedger } from "../packages/runtime-local/src/runner-local/graph-hydration.js";

const STEP_A = {
  id: "step-a",
  label: "step A",
  run: { type: "agent-step" as const, agent: "builder", task: "step-a" },
};

const STEPS = [STEP_A];

const STEP_SKILL = {
  name: "step-a",
  description: "fixture",
  body: "fixture",
  source: { type: "agent-step" as const, agent: "builder", task: "step-a", outputs: {} },
  inputs: {},
  artifacts: undefined,
  qualityProfile: undefined,
  runx: undefined,
  raw: { frontmatter: {}, rawFrontmatter: "", body: "fixture" },
} as never;

function runEvent(kind: string, stepId: string, ts: string, runId: string): ArtifactEnvelope {
  return {
    type: "run_event",
    version: "1",
    data: { kind, status: kind === "step_started" ? "started" : "completed", step_id: stepId, detail: {} },
    meta: {
      artifact_id: `ax_${kind}_${stepId}`,
      run_id: runId,
      step_id: stepId,
      producer: { skill: "fixture", runner: "graph" },
      created_at: ts,
      hash: "0".repeat(64),
      size_bytes: 64,
      parent_artifact_id: null,
      receipt_id: null,
      redacted: false,
    },
  } as unknown as ArtifactEnvelope;
}

function newRefs(state: SequentialGraphState) {
  let stateValue = state;
  let lastReceiptValue: string | undefined;
  return {
    stateRef: {
      get value() {
        return stateValue;
      },
      set value(next: SequentialGraphState) {
        stateValue = next;
      },
    },
    lastReceiptRef: {
      get value() {
        return lastReceiptValue;
      },
      set value(next: string | undefined) {
        lastReceiptValue = next;
      },
    },
    getState: () => stateValue,
  };
}

describe("hydrateGraphFromLedger orphan step_started", () => {
  it("orphan step_started (no terminal event) leaves the step in pending state", () => {
    const runId = "gx_orphan_test";
    const entries: ArtifactEnvelope[] = [
      runEvent("run_started", "", "2026-04-28T00:00:00.000Z", runId),
      runEvent("step_started", "step-a", "2026-04-28T00:00:01.000Z", runId),
      // No terminal event — the prior process was interrupted.
    ];
    const graph = { name: "test", owner: "fixture", steps: STEPS as never } as never;
    const refs = newRefs(createSequentialGraphState(runId, [{ id: "step-a" }]));
    hydrateGraphFromLedger({
      entries,
      graph,
      graphStepCache: new Map([["step-a", STEP_SKILL]]),
      graphSteps: [{ id: "step-a", contextFrom: [] }],
      stepRuns: [],
      outputs: new Map(),
      syncPoints: [],
      stateRef: refs.stateRef,
      lastReceiptRef: refs.lastReceiptRef,
    });
    const stepA = refs.getState().steps.find((s) => s.stepId === "step-a");
    expect(stepA?.status).toBe("pending");
  });

  it("step_started followed by step_succeeded hydrates to succeeded", () => {
    const runId = "gx_succeeded_test";
    const entries: ArtifactEnvelope[] = [
      runEvent("run_started", "", "2026-04-28T00:00:00.000Z", runId),
      runEvent("step_started", "step-a", "2026-04-28T00:00:01.000Z", runId),
      runEvent("step_succeeded", "step-a", "2026-04-28T00:00:02.000Z", runId),
    ];
    const graph = { name: "test", owner: "fixture", steps: STEPS as never } as never;
    const refs = newRefs(createSequentialGraphState(runId, [{ id: "step-a" }]));
    hydrateGraphFromLedger({
      entries,
      graph,
      graphStepCache: new Map([["step-a", STEP_SKILL]]),
      graphSteps: [{ id: "step-a", contextFrom: [] }],
      stepRuns: [],
      outputs: new Map(),
      syncPoints: [],
      stateRef: refs.stateRef,
      lastReceiptRef: refs.lastReceiptRef,
    });
    const stepA = refs.getState().steps.find((s) => s.stepId === "step-a");
    expect(stepA?.status).toBe("succeeded");
  });

  it("step_started followed by step_failed hydrates to failed", () => {
    const runId = "gx_failed_test";
    const entries: ArtifactEnvelope[] = [
      runEvent("run_started", "", "2026-04-28T00:00:00.000Z", runId),
      runEvent("step_started", "step-a", "2026-04-28T00:00:01.000Z", runId),
      runEvent("step_failed", "step-a", "2026-04-28T00:00:02.000Z", runId),
    ];
    const graph = { name: "test", owner: "fixture", steps: STEPS as never } as never;
    const refs = newRefs(createSequentialGraphState(runId, [{ id: "step-a" }]));
    hydrateGraphFromLedger({
      entries,
      graph,
      graphStepCache: new Map([["step-a", STEP_SKILL]]),
      graphSteps: [{ id: "step-a", contextFrom: [] }],
      stepRuns: [],
      outputs: new Map(),
      syncPoints: [],
      stateRef: refs.stateRef,
      lastReceiptRef: refs.lastReceiptRef,
    });
    const stepA = refs.getState().steps.find((s) => s.stepId === "step-a");
    expect(stepA?.status).toBe("failed");
  });
});
