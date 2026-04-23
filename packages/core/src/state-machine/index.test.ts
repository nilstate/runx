import { describe, expect, it } from "vitest";

import {
  createSequentialGraphState,
  evaluateFanoutSync,
  planSequentialGraphTransition,
  transitionSequentialGraph,
  type FanoutGroupPolicy,
  type SequentialGraphStepDefinition,
} from "./index.js";

const steps: readonly SequentialGraphStepDefinition[] = [
  { id: "first" },
  { id: "second", contextFrom: ["first"] },
  { id: "third", contextFrom: ["second"] },
];

describe("sequential chain state machine", () => {
  it("plans sequential ordering from explicit context dependencies", () => {
    let state = createSequentialGraphState("gx_test", steps);

    expect(planSequentialGraphTransition(state, steps)).toEqual({
      type: "run_step",
      stepId: "first",
      attempt: 1,
      contextFrom: [],
    });

    state = transitionSequentialGraph(state, { type: "start_step", stepId: "first", at: "2026-04-10T00:00:00.000Z" });
    expect(planSequentialGraphTransition(state, steps)).toMatchObject({
      type: "blocked",
      stepId: "first",
    });

    state = transitionSequentialGraph(state, {
      type: "step_succeeded",
      stepId: "first",
      at: "2026-04-10T00:00:01.000Z",
      receiptId: "rx_first",
    });
    expect(planSequentialGraphTransition(state, steps)).toEqual({
      type: "run_step",
      stepId: "second",
      attempt: 1,
      contextFrom: ["first"],
    });
  });

  it("completes only after all steps succeed", () => {
    let state = createSequentialGraphState("gx_test", steps.slice(0, 1));
    state = transitionSequentialGraph(state, { type: "start_step", stepId: "first", at: "2026-04-10T00:00:00.000Z" });
    state = transitionSequentialGraph(state, {
      type: "step_succeeded",
      stepId: "first",
      at: "2026-04-10T00:00:01.000Z",
      receiptId: "rx_first",
    });

    expect(planSequentialGraphTransition(state, steps.slice(0, 1))).toEqual({ type: "complete" });
    expect(transitionSequentialGraph(state, { type: "complete" }).status).toBe("succeeded");
  });

  it("reports failure when retry budget is exhausted", () => {
    const retrySteps: readonly SequentialGraphStepDefinition[] = [{ id: "first", retry: { maxAttempts: 2 } }];
    let state = createSequentialGraphState("gx_test", retrySteps);

    state = transitionSequentialGraph(state, { type: "start_step", stepId: "first", at: "2026-04-10T00:00:00.000Z" });
    state = transitionSequentialGraph(state, {
      type: "step_failed",
      stepId: "first",
      at: "2026-04-10T00:00:01.000Z",
      error: "boom",
    });

    expect(planSequentialGraphTransition(state, retrySteps)).toEqual({
      type: "run_step",
      stepId: "first",
      attempt: 2,
      contextFrom: [],
    });

    state = transitionSequentialGraph(state, { type: "start_step", stepId: "first", at: "2026-04-10T00:00:02.000Z" });
    state = transitionSequentialGraph(state, {
      type: "step_failed",
      stepId: "first",
      at: "2026-04-10T00:00:03.000Z",
      error: "boom",
    });

    expect(planSequentialGraphTransition(state, retrySteps)).toEqual({
      type: "failed",
      stepId: "first",
      reason: "step failed and retry budget is exhausted",
    });
  });

  it("is deterministic for the same chain state", () => {
    const state = createSequentialGraphState("gx_test", steps);

    expect(planSequentialGraphTransition(state, steps)).toEqual(planSequentialGraphTransition(state, steps));
  });
});

describe("fanout sync graph policy", () => {
  const fanoutSteps: readonly SequentialGraphStepDefinition[] = [
    { id: "market", fanoutGroup: "advisors" },
    { id: "risk", fanoutGroup: "advisors" },
    { id: "finance", fanoutGroup: "advisors" },
    { id: "synthesize", contextFrom: ["market", "risk"] },
  ];

  const quorumPolicy: FanoutGroupPolicy = {
    groupId: "advisors",
    strategy: "quorum",
    minSuccess: 2,
    onBranchFailure: "continue",
    thresholdGates: [],
    conflictGates: [],
  };

  it("plans a deterministic fanout branch set", () => {
    const state = createSequentialGraphState("gx_test", fanoutSteps);

    expect(planSequentialGraphTransition(state, fanoutSteps, { advisors: quorumPolicy })).toEqual({
      type: "run_fanout",
      groupId: "advisors",
      stepIds: ["market", "risk", "finance"],
      attempts: {
        market: 1,
        risk: 1,
        finance: 1,
      },
      contextFrom: {
        market: [],
        risk: [],
        finance: [],
      },
    });
  });

  it("proceeds when quorum succeeds with one failed branch", () => {
    let state = createSequentialGraphState("gx_test", fanoutSteps);
    state = finishFanoutStep(state, "market", "succeeded", { recommendation: "go" });
    state = finishFanoutStep(state, "risk", "succeeded", { risk_score: 0.2 });
    state = finishFanoutStep(state, "finance", "failed");

    expect(planSequentialGraphTransition(state, fanoutSteps, { advisors: quorumPolicy })).toEqual({
      type: "run_step",
      stepId: "synthesize",
      attempt: 1,
      contextFrom: ["market", "risk"],
    });
  });

  it("halts when quorum is not met", () => {
    let state = createSequentialGraphState("gx_test", fanoutSteps.slice(0, 3));
    state = finishFanoutStep(state, "market", "succeeded");
    state = finishFanoutStep(state, "risk", "failed");
    state = finishFanoutStep(state, "finance", "failed");

    expect(planSequentialGraphTransition(state, fanoutSteps.slice(0, 3), { advisors: quorumPolicy })).toMatchObject({
      type: "failed",
      stepId: "market",
      syncDecision: {
        groupId: "advisors",
        decision: "halt",
        ruleFired: "quorum.min_success",
      },
    });
  });

  it("halts on any failed branch when branch failure policy is halt", () => {
    const decision = evaluateFanoutSync(
      {
        ...quorumPolicy,
        onBranchFailure: "halt",
      },
      [
        { stepId: "market", status: "succeeded" },
        { stepId: "risk", status: "succeeded" },
        { stepId: "finance", status: "failed" },
      ],
    );

    expect(decision).toMatchObject({
      groupId: "advisors",
      decision: "halt",
      ruleFired: "branch_failure.halt",
      successCount: 2,
      failureCount: 1,
    });
  });

  it("pauses on structured threshold gates", () => {
    const decision = evaluateFanoutSync(
      {
        groupId: "advisors",
        strategy: "all",
        onBranchFailure: "halt",
        thresholdGates: [{ step: "risk", field: "risk_score", above: 0.8, action: "pause" }],
        conflictGates: [],
      },
      [
        { stepId: "market", status: "succeeded", outputs: { recommendation: "go" } },
        { stepId: "risk", status: "succeeded", outputs: { risk_score: 0.91 } },
      ],
    );

    expect(decision).toMatchObject({
      groupId: "advisors",
      decision: "pause",
      ruleFired: "threshold.risk.risk_score.above",
      gate: {
        type: "threshold",
        field: "risk_score",
        value: 0.91,
      },
    });
  });

  it("does not treat nested objects with different key order as a conflict", () => {
    const decision = evaluateFanoutSync(
      {
        groupId: "advisors",
        strategy: "all",
        minSuccess: 2,
        onBranchFailure: "halt",
        thresholdGates: [],
        conflictGates: [{ field: "report", action: "pause", steps: ["market", "risk"] }],
      },
      [
        {
          stepId: "market",
          status: "succeeded",
          outputs: {
            report: {
              summary: {
                z: 1,
                a: 2,
              },
            },
          },
        },
        {
          stepId: "risk",
          status: "succeeded",
          outputs: {
            report: {
              summary: {
                a: 2,
                z: 1,
              },
            },
          },
        },
      ],
    );

    expect(decision).toMatchObject({
      groupId: "advisors",
      decision: "proceed",
      ruleFired: "all.min_success",
      successCount: 2,
      failureCount: 0,
    });
  });
});

function finishFanoutStep(
  state: ReturnType<typeof createSequentialGraphState>,
  stepId: string,
  status: "succeeded" | "failed",
  outputs: Readonly<Record<string, unknown>> = {},
): ReturnType<typeof createSequentialGraphState> {
  let next = transitionSequentialGraph(state, { type: "start_step", stepId, at: "2026-04-10T00:00:00.000Z" });
  next =
    status === "succeeded"
      ? transitionSequentialGraph(next, {
          type: "step_succeeded",
          stepId,
          at: "2026-04-10T00:00:01.000Z",
          receiptId: `rx_${stepId}`,
          outputs,
        })
      : transitionSequentialGraph(next, {
          type: "step_failed",
          stepId,
          at: "2026-04-10T00:00:01.000Z",
          error: "boom",
        });
  return next;
}
