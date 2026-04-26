export const stateMachinePackage = "@runxhq/core/state-machine";

export type StepStatus = "pending" | "admitted" | "running" | "succeeded" | "failed";
export type GraphStatus = "pending" | "running" | "succeeded" | "failed" | "paused" | "escalated";
export type GraphStepStatus = "pending" | "running" | "succeeded" | "failed";
export type FanoutSyncStrategy = "all" | "any" | "quorum";
export type FanoutBranchFailurePolicy = "halt" | "continue";
export type FanoutGateAction = "pause" | "escalate";

export interface SingleStepState {
  readonly stepId: string;
  readonly status: StepStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface SequentialGraphStepDefinition {
  readonly id: string;
  readonly contextFrom?: readonly string[];
  readonly retry?: {
    readonly maxAttempts: number;
  };
  readonly fanoutGroup?: string;
}

export interface FanoutThresholdGate {
  readonly step: string;
  readonly field: string;
  readonly above: number;
  readonly action: FanoutGateAction;
}

export interface FanoutConflictGate {
  readonly field: string;
  readonly steps: readonly string[];
  readonly action: FanoutGateAction;
}

export interface FanoutGroupPolicy {
  readonly groupId: string;
  readonly strategy: FanoutSyncStrategy;
  readonly minSuccess?: number;
  readonly onBranchFailure: FanoutBranchFailurePolicy;
  readonly thresholdGates?: readonly FanoutThresholdGate[];
  readonly conflictGates?: readonly FanoutConflictGate[];
}

export interface FanoutBranchResult {
  readonly stepId: string;
  readonly status: GraphStepStatus;
  readonly outputs?: Readonly<Record<string, unknown>>;
}

export interface FanoutSyncDecision {
  readonly groupId: string;
  readonly decision: "proceed" | "halt" | "pause" | "escalate";
  readonly strategy: FanoutSyncStrategy;
  readonly ruleFired: string;
  readonly reason: string;
  readonly branchCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly requiredSuccesses: number;
  readonly gate?: {
    readonly type: "threshold" | "conflict";
    readonly stepId?: string;
    readonly field: string;
    readonly value?: unknown;
    readonly comparedTo?: number;
    readonly values?: Readonly<Record<string, unknown>>;
    readonly action: FanoutGateAction;
  };
}

export function fanoutSyncDecisionKey(decision: Pick<FanoutSyncDecision, "groupId" | "ruleFired">): string {
  return `${decision.groupId}:${decision.ruleFired}`;
}

export interface SequentialGraphStepState {
  readonly stepId: string;
  readonly status: GraphStepStatus;
  readonly attempts: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly receiptId?: string;
  readonly outputs?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface SequentialGraphState {
  readonly graphId: string;
  readonly status: GraphStatus;
  readonly steps: readonly SequentialGraphStepState[];
}

export type SequentialGraphEvent =
  | { readonly type: "start_step"; readonly stepId: string; readonly at: string }
  | {
      readonly type: "step_succeeded";
      readonly stepId: string;
      readonly at: string;
      readonly receiptId: string;
      readonly outputs?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "step_failed"; readonly stepId: string; readonly at: string; readonly error: string }
  | { readonly type: "complete" }
  | { readonly type: "pause_graph"; readonly reason: string }
  | { readonly type: "escalate_graph"; readonly reason: string }
  | { readonly type: "fail_graph"; readonly error: string };

export type SequentialGraphPlan =
  | {
      readonly type: "run_step";
      readonly stepId: string;
      readonly attempt: number;
      readonly contextFrom: readonly string[];
    }
  | {
      readonly type: "run_fanout";
      readonly groupId: string;
      readonly stepIds: readonly string[];
      readonly attempts: Readonly<Record<string, number>>;
      readonly contextFrom: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly type: "complete" }
  | { readonly type: "failed"; readonly stepId: string; readonly reason: string; readonly syncDecision?: FanoutSyncDecision }
  | { readonly type: "blocked"; readonly stepId: string; readonly reason: string; readonly syncDecision?: FanoutSyncDecision }
  | { readonly type: "paused"; readonly stepId: string; readonly reason: string; readonly syncDecision: FanoutSyncDecision }
  | { readonly type: "escalated"; readonly stepId: string; readonly reason: string; readonly syncDecision: FanoutSyncDecision };

export type SingleStepEvent =
  | { readonly type: "admit" }
  | { readonly type: "start"; readonly at: string }
  | { readonly type: "succeed"; readonly at: string }
  | { readonly type: "fail"; readonly at: string; readonly error: string };

export function createSingleStepState(stepId: string): SingleStepState {
  return {
    stepId,
    status: "pending",
  };
}

export function transitionSingleStep(state: SingleStepState, event: SingleStepEvent): SingleStepState {
  switch (event.type) {
    case "admit":
      if (state.status !== "pending") {
        return state;
      }
      return {
        ...state,
        status: "admitted",
      };
    case "start":
      if (state.status !== "admitted") {
        return state;
      }
      return {
        ...state,
        status: "running",
        startedAt: event.at,
      };
    case "succeed":
      if (state.status !== "running") {
        return state;
      }
      return {
        ...state,
        status: "succeeded",
        completedAt: event.at,
      };
    case "fail":
      if (state.status !== "running") {
        return state;
      }
      return {
        ...state,
        status: "failed",
        completedAt: event.at,
        error: event.error,
      };
  }
}

export function createSequentialGraphState(
  graphId: string,
  steps: readonly SequentialGraphStepDefinition[],
): SequentialGraphState {
  return {
    graphId,
    status: "pending",
    steps: steps.map((step) => ({
      stepId: step.id,
      status: "pending",
      attempts: 0,
    })),
  };
}

export function planSequentialGraphTransition(
  state: SequentialGraphState,
  steps: readonly SequentialGraphStepDefinition[],
  fanoutPolicies: Readonly<Record<string, FanoutGroupPolicy>> = {},
  options: {
    readonly resolvedFanoutGateKeys?: ReadonlySet<string>;
  } = {},
): SequentialGraphPlan {
  const runningStep = state.steps.find((step) => step.status === "running");
  if (runningStep) {
    return {
      type: "blocked",
      stepId: runningStep.stepId,
      reason: "step is already running",
    };
  }

  for (let index = 0; index < steps.length; index += 1) {
    const stepDefinition = steps[index];
    if (!stepDefinition) {
      continue;
    }

    if (stepDefinition.fanoutGroup) {
      const groupSteps = collectContiguousFanoutGroup(steps, index, stepDefinition.fanoutGroup);
      const groupPlan = planFanoutGroup(state, groupSteps, fanoutPolicies[stepDefinition.fanoutGroup], options.resolvedFanoutGateKeys);
      if (groupPlan.type === "proceed") {
        index += groupSteps.length - 1;
        continue;
      }
      return groupPlan.plan;
    }

    const stepState = findStepState(state, stepDefinition.id);
    if (!stepState) {
      return {
        type: "failed",
        stepId: stepDefinition.id,
        reason: "step state is missing",
      };
    }

    if (stepState.status === "succeeded") {
      continue;
    }

    const maxAttempts = stepDefinition.retry?.maxAttempts ?? 1;
    if (stepState.status === "failed" && stepState.attempts >= maxAttempts) {
      return {
        type: "failed",
        stepId: stepDefinition.id,
        reason: "step failed and retry budget is exhausted",
      };
    }

    const contextFrom = stepDefinition.contextFrom ?? [];
    const missingContext = contextFrom.find((stepId) => findStepState(state, stepId)?.status !== "succeeded");
    if (missingContext) {
      return {
        type: "blocked",
        stepId: stepDefinition.id,
        reason: `waiting for context from ${missingContext}`,
      };
    }

    return {
      type: "run_step",
      stepId: stepDefinition.id,
      attempt: stepState.attempts + 1,
      contextFrom,
    };
  }

  return {
    type: "complete",
  };
}

export function transitionSequentialGraph(
  state: SequentialGraphState,
  event: SequentialGraphEvent,
): SequentialGraphState {
  switch (event.type) {
    case "start_step":
      return updateStep(state, event.stepId, (step) => {
        if (step.status === "running" || step.status === "succeeded") {
          return step;
        }
        return {
          ...step,
          status: "running",
          attempts: step.attempts + 1,
          startedAt: event.at,
          completedAt: undefined,
          outputs: undefined,
          error: undefined,
        };
      }, "running");
    case "step_succeeded":
      return updateStep(state, event.stepId, (step) => {
        if (step.status !== "running") {
          return step;
        }
        return {
          ...step,
          status: "succeeded",
          completedAt: event.at,
          receiptId: event.receiptId,
          outputs: event.outputs,
          error: undefined,
        };
      });
    case "step_failed":
      return updateStep(state, event.stepId, (step) => {
        if (step.status !== "running") {
          return step;
        }
        return {
          ...step,
          status: "failed",
          completedAt: event.at,
          outputs: undefined,
          error: event.error,
        };
      });
    case "complete":
      if (state.steps.every((step) => step.status !== "pending" && step.status !== "running")) {
        return {
          ...state,
          status: "succeeded",
        };
      }
      return state;
    case "pause_graph":
      return {
        ...state,
        status: "paused",
      };
    case "escalate_graph":
      return {
        ...state,
        status: "escalated",
      };
    case "fail_graph":
      return {
        ...state,
        status: "failed",
      };
  }
}

export function evaluateFanoutSync(
  policy: FanoutGroupPolicy,
  results: readonly FanoutBranchResult[],
  options: {
    readonly resolvedGateKeys?: ReadonlySet<string>;
  } = {},
): FanoutSyncDecision {
  const branchCount = results.length;
  const successCount = results.filter((result) => result.status === "succeeded").length;
  const failureCount = results.filter((result) => result.status === "failed").length;
  const requiredSuccesses = requiredSuccessCount(policy, branchCount);

  if (policy.onBranchFailure === "halt" && failureCount > 0) {
    return syncDecision(policy, "halt", "quorum", branchCount, successCount, failureCount, requiredSuccesses, {
      ruleFired: "branch_failure.halt",
      reason: `${failureCount}/${branchCount} branches failed and on_branch_failure is halt`,
    });
  }

  for (const gate of policy.thresholdGates ?? []) {
    const result = results.find((candidate) => candidate.stepId === gate.step);
    if (!result || result.status !== "succeeded") {
      continue;
    }
    const value = resolveStructuredField(result.outputs, gate.field);
    if (value === undefined) {
      return syncDecision(policy, "halt", "threshold", branchCount, successCount, failureCount, requiredSuccesses, {
        ruleFired: `threshold.${gate.step}.${gate.field}.missing`,
        reason: `threshold field ${gate.step}.${gate.field} was not produced`,
        gate: {
          type: "threshold",
          stepId: gate.step,
          field: gate.field,
          action: gate.action,
        },
      });
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return syncDecision(policy, "halt", "threshold", branchCount, successCount, failureCount, requiredSuccesses, {
        ruleFired: `threshold.${gate.step}.${gate.field}.non_numeric`,
        reason: `threshold field ${gate.step}.${gate.field} must be numeric`,
        gate: {
          type: "threshold",
          stepId: gate.step,
          field: gate.field,
          value,
          action: gate.action,
        },
      });
    }
    if (value > gate.above) {
      const decision = syncDecision(policy, gate.action, "threshold", branchCount, successCount, failureCount, requiredSuccesses, {
        ruleFired: `threshold.${gate.step}.${gate.field}.above`,
        reason: `${gate.step}.${gate.field}=${value} exceeded ${gate.above}`,
        gate: {
          type: "threshold",
          stepId: gate.step,
          field: gate.field,
          value,
          comparedTo: gate.above,
          action: gate.action,
        },
      });
      if (!options.resolvedGateKeys?.has(fanoutSyncDecisionKey(decision))) {
        return decision;
      }
    }
  }

  for (const gate of policy.conflictGates ?? []) {
    const candidateResults = results.filter(
      (result) => result.status === "succeeded" && (gate.steps.length === 0 || gate.steps.includes(result.stepId)),
    );
    const values = Object.fromEntries(
      candidateResults.map((result) => [result.stepId, resolveStructuredField(result.outputs, gate.field)]),
    );
    const distinct = new Set(Object.values(values).map((value) => stableValue(value)));
    if (distinct.size > 1) {
      const decision = syncDecision(policy, gate.action, "conflict", branchCount, successCount, failureCount, requiredSuccesses, {
        ruleFired: `conflict.${gate.field}`,
        reason: `fanout branches disagreed on structured field ${gate.field}`,
        gate: {
          type: "conflict",
          field: gate.field,
          values,
          action: gate.action,
        },
      });
      if (!options.resolvedGateKeys?.has(fanoutSyncDecisionKey(decision))) {
        return decision;
      }
    }
  }

  if (successCount >= requiredSuccesses) {
    return syncDecision(policy, "proceed", "quorum", branchCount, successCount, failureCount, requiredSuccesses, {
      ruleFired: `${policy.strategy}.min_success`,
      reason: `${successCount}/${branchCount} branches succeeded; required ${requiredSuccesses}`,
    });
  }

  return syncDecision(policy, "halt", "quorum", branchCount, successCount, failureCount, requiredSuccesses, {
    ruleFired: `${policy.strategy}.min_success`,
    reason: `${successCount}/${branchCount} branches succeeded; required ${requiredSuccesses}`,
  });
}

function planFanoutGroup(
  state: SequentialGraphState,
  groupSteps: readonly SequentialGraphStepDefinition[],
  policy: FanoutGroupPolicy | undefined,
  resolvedFanoutGateKeys: ReadonlySet<string> | undefined,
):
  | { readonly type: "proceed" }
  | {
      readonly type: "plan";
      readonly plan: SequentialGraphPlan;
    } {
  const firstStep = groupSteps[0];
  if (!firstStep?.fanoutGroup) {
    return {
      type: "plan",
      plan: {
        type: "failed",
        stepId: firstStep?.id ?? "unknown",
        reason: "fanout group is empty",
      },
    };
  }

  const fanoutPolicy =
    policy ??
    ({
      groupId: firstStep.fanoutGroup,
      strategy: "all",
      onBranchFailure: "halt",
      thresholdGates: [],
      conflictGates: [],
    } satisfies FanoutGroupPolicy);

  const candidates: SequentialGraphStepDefinition[] = [];
  const attempts: Record<string, number> = {};
  const contextFrom: Record<string, readonly string[]> = {};

  for (const stepDefinition of groupSteps) {
    const stepState = findStepState(state, stepDefinition.id);
    if (!stepState) {
      return {
        type: "plan",
        plan: {
          type: "failed",
          stepId: stepDefinition.id,
          reason: "step state is missing",
        },
      };
    }
    if (stepState.status === "succeeded") {
      continue;
    }

    const maxAttempts = stepDefinition.retry?.maxAttempts ?? 1;
    if (stepState.status === "failed" && stepState.attempts >= maxAttempts) {
      continue;
    }

    const context = stepDefinition.contextFrom ?? [];
    const missingContext = context.find((stepId) => findStepState(state, stepId)?.status !== "succeeded");
    if (missingContext) {
      return {
        type: "plan",
        plan: {
          type: "blocked",
          stepId: stepDefinition.id,
          reason: `waiting for context from ${missingContext}`,
        },
      };
    }

    candidates.push(stepDefinition);
    attempts[stepDefinition.id] = stepState.attempts + 1;
    contextFrom[stepDefinition.id] = context;
  }

  if (candidates.length > 0) {
    return {
      type: "plan",
      plan: {
        type: "run_fanout",
        groupId: firstStep.fanoutGroup,
        stepIds: candidates.map((step) => step.id),
        attempts,
        contextFrom,
      },
    };
  }

  const decision = evaluateFanoutSync(
    fanoutPolicy,
    groupSteps.map((step) => {
      const stepState = findStepState(state, step.id);
      return {
        stepId: step.id,
        status: stepState?.status ?? "failed",
        outputs: stepState?.outputs,
      };
    }),
    { resolvedGateKeys: resolvedFanoutGateKeys },
  );
  if (decision.decision === "proceed") {
    return { type: "proceed" };
  }

  return {
    type: "plan",
    plan: {
      type: decision.decision === "halt"
        ? "failed"
        : decision.decision === "pause"
          ? "paused"
          : "escalated",
      stepId: firstStep.id,
      reason: decision.reason,
      syncDecision: decision,
    },
  };
}

function collectContiguousFanoutGroup(
  steps: readonly SequentialGraphStepDefinition[],
  startIndex: number,
  groupId: string,
): readonly SequentialGraphStepDefinition[] {
  const groupSteps: SequentialGraphStepDefinition[] = [];
  for (let index = startIndex; index < steps.length; index += 1) {
    const step = steps[index];
    if (step?.fanoutGroup !== groupId) {
      break;
    }
    groupSteps.push(step);
  }
  return groupSteps;
}

function requiredSuccessCount(policy: FanoutGroupPolicy, branchCount: number): number {
  if (policy.strategy === "all") {
    return branchCount;
  }
  if (policy.strategy === "any") {
    return 1;
  }
  return policy.minSuccess ?? branchCount;
}

function syncDecision(
  policy: FanoutGroupPolicy,
  decision: FanoutSyncDecision["decision"],
  _type: "threshold" | "conflict" | "quorum",
  branchCount: number,
  successCount: number,
  failureCount: number,
  requiredSuccesses: number,
  details: Pick<FanoutSyncDecision, "ruleFired" | "reason" | "gate">,
): FanoutSyncDecision {
  return {
    groupId: policy.groupId,
    decision,
    strategy: policy.strategy,
    branchCount,
    successCount,
    failureCount,
    requiredSuccesses,
    ...details,
  };
}

function findStepState(state: SequentialGraphState, stepId: string): SequentialGraphStepState | undefined {
  return state.steps.find((step) => step.stepId === stepId);
}

function updateStep(
  state: SequentialGraphState,
  stepId: string,
  update: (step: SequentialGraphStepState) => SequentialGraphStepState,
  nextStatus: GraphStatus = state.status,
): SequentialGraphState {
  return {
    ...state,
    status: nextStatus,
    steps: state.steps.map((step) => (step.stepId === stepId ? update(step) : step)),
  };
}

function resolveStructuredField(outputs: Readonly<Record<string, unknown>> | undefined, fieldPath: string): unknown {
  return fieldPath.split(".").reduce<unknown>((value, key) => {
    if (!isRecord(value) || !(key in value)) {
      return undefined;
    }
    return value[key];
  }, outputs);
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableValue(item)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableValue(entryValue)}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
