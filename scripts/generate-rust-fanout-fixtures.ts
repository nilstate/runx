import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  evaluateRustKernelInputSync,
  type FanoutBranchResult,
  type FanoutGroupPolicy,
  type FanoutSyncDecision,
} from "./rust-kernel-eval.js";

type Scenario = "all" | "partial-failure" | "retry";

interface StepExpectation {
  readonly id: string;
  readonly status: "success" | "failure";
  readonly attempt?: number;
  readonly fanoutGroup?: string;
  readonly contract?: Record<string, unknown>;
  readonly failure?: string;
}

interface SyncPointExpectation {
  readonly group_id: string;
  readonly strategy: "all" | "any" | "quorum";
  readonly decision: "proceed" | "halt" | "pause" | "escalate";
  readonly rule_fired: string;
  readonly reason: string;
  readonly branch_count: number;
  readonly success_count: number;
  readonly failure_count: number;
  readonly required_successes: number;
  readonly branch_receipts: readonly string[];
  readonly gate?: Record<string, unknown>;
}

const outputPath = resolve("fixtures/runtime/fanout/expected.json");
const generatedGraphDir = resolve("fixtures/runtime/fanout/generated");
const check = process.argv.includes("--check");
const branchCount = numberArg("--branches") ?? 5;
const selectedScenario = scenarioArg();

if (!Number.isInteger(branchCount) || branchCount < 2) {
  throw new Error("--branches must be an integer >= 2");
}

const scenarios = ["partial-failure", "retry"] satisfies Scenario[];
const writeScenarios = selectedScenario ? [selectedScenario] : scenarios;
const fixture = {
  allSuccess: staticAllSuccess(),
  quorumContinue: staticQuorumContinue(),
  thresholdPause: staticThresholdPause(),
  generated: Object.fromEntries(
    scenarios.map((scenario) => [camelScenario(scenario), generatedScenario(scenario, branchCount)]),
  ),
};

for (const scenario of writeScenarios) {
  reconcileGeneratedGraph(scenario, branchCount);
}

const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
writeOrCheck(outputPath, serialized);

function staticAllSuccess() {
  return {
    graph: "fanout-all-success",
    status: "succeeded",
    steps: [
      step("market", "success", { recommendation: "go" }),
      step("risk", "success", { risk_score: 0.2 }),
      step("finance", "success", { budget: "approved" }),
      { id: "synthesize", status: "success" },
    ] satisfies readonly StepExpectation[],
    syncPoints: [
      syncPoint({
        graph: "fanout-all-success",
        strategy: "all",
        decision: "proceed",
        ruleFired: "all.min_success",
        reason: "3/3 branches succeeded; required 3",
        branchCount: 3,
        successCount: 3,
        requiredSuccesses: 3,
        branchIds: ["market", "risk", "finance"],
      }),
    ],
  };
}

function staticQuorumContinue() {
  return {
    graph: "fanout-advisors",
    status: "succeeded",
    steps: [
      step("market", "success", { confidence: 0.9, recommendation: "go" }),
      step("risk", "success", { recommendation: "go", risk_score: 0.4 }),
      step("finance", "failure", undefined, "fixture failure"),
      { id: "synthesize", status: "success" },
    ] satisfies readonly StepExpectation[],
    syncPoints: [
      syncPoint({
        graph: "fanout-advisors",
        strategy: "quorum",
        decision: "proceed",
        ruleFired: "quorum.min_success",
        reason: "2/3 branches succeeded; required 2",
        branchCount: 3,
        successCount: 2,
        requiredSuccesses: 2,
        branchIds: ["market", "risk", "finance"],
      }),
    ],
  };
}

function staticThresholdPause() {
  return {
    graph: "fanout-threshold",
    status: "paused",
    stepId: "market",
    syncPoint: syncPointFromRust(
      {
        groupId: "advisors",
        strategy: "all",
        onBranchFailure: "halt",
        thresholdGates: [
          {
            step: "risk",
            field: "result.data.risk_score",
            above: 0.8,
            action: "pause",
          },
        ],
      },
      [
        { stepId: "market", status: "succeeded", outputs: { recommendation: "go" } },
        {
          stepId: "risk",
          status: "succeeded",
          outputs: { result: { data: { risk_score: 0.91 } } },
        },
      ],
      [
        "hrn_rcpt_fanout-threshold_market",
        "hrn_rcpt_fanout-threshold_risk",
      ],
    ),
  };
}

function generatedScenario(scenario: Scenario, branches: number) {
  if (scenario === "retry") {
    return generatedRetry(branches);
  }
  if (scenario === "partial-failure") {
    return generatedPartialFailure(branches);
  }
  return generatedAll(branches);
}

function generatedAll(branches: number) {
  const graph = `fanout-generated-all-${branches}`;
  const branchIds = branchIdsFor(branches);
  return {
    graph,
    graphPath: `../../fixtures/runtime/fanout/generated/${graph}.yaml`,
    status: "succeeded",
    branchCount: branches,
    steps: [
      ...branchIds.map((id, index) => step(id, "success", { recommendation: `go-${index}` })),
      { id: "synthesize", status: "success" },
    ],
    syncPoints: [
      syncPoint({
        graph,
        strategy: "all",
        decision: "proceed",
        ruleFired: "all.min_success",
        reason: `${branches}/${branches} branches succeeded; required ${branches}`,
        branchCount: branches,
        successCount: branches,
        requiredSuccesses: branches,
        branchIds,
      }),
    ],
  };
}

function generatedPartialFailure(branches: number) {
  const graph = `fanout-generated-partial-failure-${branches}`;
  const branchIds = branchIdsFor(branches);
  const successCount = branches - 1;
  return {
    graph,
    graphPath: `../../fixtures/runtime/fanout/generated/${graph}.yaml`,
    status: "succeeded",
    branchCount: branches,
    steps: [
      ...branchIds.slice(0, successCount).map((id, index) =>
        step(id, "success", { recommendation: `go-${index}` })),
      step(branchIds[branches - 1]!, "failure", undefined, "fixture failure"),
      { id: "synthesize", status: "success" },
    ],
    syncPoints: [
      syncPoint({
        graph,
        strategy: "quorum",
        decision: "proceed",
        ruleFired: "quorum.min_success",
        reason: `${successCount}/${branches} branches succeeded; required ${successCount}`,
        branchCount: branches,
        successCount,
        requiredSuccesses: successCount,
        branchIds,
      }),
    ],
  };
}

function generatedRetry(branches: number) {
  const graph = `fanout-generated-retry-${branches}`;
  const branchIds = branchIdsFor(branches);
  const failingBranch = branchIds[branches - 1]!;
  return {
    graph,
    graphPath: `../../fixtures/runtime/fanout/generated/${graph}.yaml`,
    status: "failed",
    branchCount: branches,
    retryStepId: failingBranch,
    retryAttempts: 2,
    checkpointSteps: [
      ...branchIds.slice(0, branches - 1).map((id, index) =>
        step(id, "success", { recommendation: `go-${index}` })),
      step(failingBranch, "failure", undefined, "fixture failure"),
      {
        ...step(failingBranch, "failure", undefined, "fixture failure"),
        attempt: 2,
      },
    ] satisfies readonly StepExpectation[],
    syncPoint: syncPoint({
      graph,
      strategy: "all",
      decision: "halt",
      ruleFired: "all.min_success",
      reason: `${branches - 1}/${branches} branches succeeded; required ${branches}`,
      branchCount: branches,
      successCount: branches - 1,
      requiredSuccesses: branches,
      branchIds,
      receiptIds: branchIds.map((id) =>
        id === failingBranch ? `${receiptId(graph, id)}_attempt_2` : receiptId(graph, id)),
    }),
  };
}

function reconcileGeneratedGraph(scenario: Scenario, branches: number) {
  const graph = generatedScenario(scenario, branches);
  const yaml = graphYaml(scenario, branches, graph.graph);
  writeOrCheck(resolve(generatedGraphDir, `${graph.graph}.yaml`), yaml);
}

function writeOrCheck(path: string, contents: string) {
  if (check) {
    const current = readFileSync(path, "utf8");
    if (current !== contents) {
      throw new Error(`${path} is stale; run this script without --check`);
    }
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function graphYaml(scenario: Scenario, branches: number, graphName: string): string {
  const strategy = scenario === "partial-failure" ? "quorum" : "all";
  const minSuccess = scenario === "partial-failure" ? `      min_success: ${branches - 1}\n` : "";
  return `name: ${graphName}
owner: runx
fanout:
  groups:
    advisors:
      strategy: ${strategy}
${minSuccess}      on_branch_failure: continue
steps:
${branchIdsFor(branches).map((id, index) => branchYaml(id, index, scenario, branches)).join("")}  - id: synthesize
    skill: ../../../skills/echo
    context:
      message: branch_0.result.data.recommendation
`;
}

function branchYaml(id: string, index: number, scenario: Scenario, branches: number): string {
  const failing = index === branches - 1 && (scenario === "partial-failure" || scenario === "retry");
  const retry = scenario === "retry" && failing
    ? `    retry:
      max_attempts: 2
`
    : "";
  if (failing) {
    return `  - id: ${id}
    mode: fanout
    fanout_group: advisors
    skill: ../../../skills/failing
${retry}`;
  }
  return `  - id: ${id}
    mode: fanout
    fanout_group: advisors
    skill: ../../../skills/json-output
    inputs:
      recommendation: go-${index}
`;
}

function step(
  id: string,
  status: "success" | "failure",
  data?: Record<string, unknown>,
  failure?: string,
): StepExpectation {
  return {
    id,
    status,
    attempt: 1,
    fanoutGroup: "advisors",
    // Branch skills declare one `result` output; the runtime projects their
    // JSON claim into the typed step contract wrapped in the data envelope.
    contract: data ? { result: { data } } : undefined,
    failure,
  };
}

function syncPoint(input: {
  readonly graph: string;
  readonly strategy: "all" | "any" | "quorum";
  readonly decision: "proceed" | "halt" | "pause" | "escalate";
  readonly ruleFired: string;
  readonly reason: string;
  readonly branchCount: number;
  readonly successCount: number;
  readonly requiredSuccesses: number;
  readonly branchIds: readonly string[];
  readonly receiptIds?: readonly string[];
}): SyncPointExpectation {
  const policy: FanoutGroupPolicy = {
    groupId: "advisors",
    strategy: input.strategy,
    minSuccess: input.strategy === "quorum" ? input.requiredSuccesses : undefined,
    onBranchFailure: "continue",
  };
  const results = input.branchIds.map((id, index): FanoutBranchResult => ({
    stepId: id,
    status: index < input.successCount ? "succeeded" : "failed",
    outputs: {},
  }));
  const point = syncPointFromRust(
    policy,
    results,
    input.receiptIds ?? input.branchIds.map((id) => receiptId(input.graph, id)),
  );
  assertSyncPointField(point.decision, input.decision, "decision");
  assertSyncPointField(point.rule_fired, input.ruleFired, "rule_fired");
  assertSyncPointField(point.reason, input.reason, "reason");
  return point;
}

function syncPointFromRust(
  policy: FanoutGroupPolicy,
  results: readonly FanoutBranchResult[],
  branchReceipts: readonly string[],
): SyncPointExpectation {
  const decision = evaluateFanoutSync(policy, results);
  return {
    group_id: decision.groupId,
    strategy: decision.strategy,
    decision: decision.decision,
    rule_fired: decision.ruleFired,
    reason: decision.reason,
    branch_count: decision.branchCount,
    success_count: decision.successCount,
    failure_count: decision.failureCount,
    required_successes: decision.requiredSuccesses,
    branch_receipts: branchReceipts,
    gate: decision.gate,
  };
}

function evaluateFanoutSync(
  policy: FanoutGroupPolicy,
  results: readonly FanoutBranchResult[],
): FanoutSyncDecision {
  return evaluateRustKernelInputSync({
    kind: "state-machine.evaluateFanoutSync",
    policy,
    results,
  }) as FanoutSyncDecision;
}

function assertSyncPointField(actual: string, expected: string, field: string) {
  if (actual !== expected) {
    throw new Error(`Rust fanout oracle produced ${field}=${actual}; expected ${expected}`);
  }
}

function receiptId(graph: string, stepId: string): string {
  return `hrn_rcpt_${graph}_${stepId}`;
}

function branchIdsFor(branches: number): readonly string[] {
  return Array.from({ length: branches }, (_, index) => `branch_${index}`);
}

function numberArg(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value) {
    throw new Error(`${name} requires a value`);
  }
  return Number(value);
}

function scenarioArg(): Scenario | undefined {
  const index = process.argv.indexOf("--scenario");
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value !== "all" && value !== "partial-failure" && value !== "retry") {
    throw new Error("--scenario must be all, partial-failure, or retry");
  }
  return value;
}

function camelScenario(scenario: Scenario): string {
  if (scenario === "partial-failure") {
    return "partialFailure";
  }
  return scenario;
}
