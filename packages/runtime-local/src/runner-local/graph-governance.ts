import { admitGraphStepScopes, type GraphScopeGrant } from "@runxhq/core/policy";
import {
  writeLocalGraphReceipt,
  type GraphReceiptStep,
  type GraphReceiptSyncPoint,
  type LocalGraphReceipt,
} from "@runxhq/core/receipts";
import type { ExecutionGraph, GraphStep } from "@runxhq/core/parser";
import type { FanoutSyncDecision } from "@runxhq/core/state-machine";

import { graphStepReference, graphStepRunner } from "./graph-reporting.js";
import type { GraphStepRun, MaterializedContextEdge } from "./index.js";
import type { NormalizedExecutionSemantics } from "./execution-semantics.js";

export interface GraphStepGovernance {
  readonly scopeAdmission: {
    readonly status: "allow" | "deny";
    readonly requestedScopes: readonly string[];
    readonly grantedScopes: readonly string[];
    readonly grantId?: string;
    readonly reasons?: readonly string[];
  };
}

export function buildGraphStepGovernance(step: GraphStep, graphGrant: GraphScopeGrant): GraphStepGovernance {
  const decision = admitGraphStepScopes({
    stepId: step.id,
    requestedScopes: step.scopes,
    grant: graphGrant,
  });
  return {
    scopeAdmission: {
      status: decision.status,
      requestedScopes: decision.requestedScopes,
      grantedScopes: decision.grantedScopes,
      grantId: decision.grantId,
      reasons: decision.status === "deny" ? decision.reasons : undefined,
    },
  };
}

export function governanceReceiptMetadata(
  step: GraphStep,
  governance: GraphStepGovernance,
): Readonly<Record<string, unknown>> {
  return {
    graph_governance: {
      step_id: step.id,
      selected_runner: graphStepRunner(step) ?? "default",
      scope_admission: {
        status: governance.scopeAdmission.status,
        requested_scopes: governance.scopeAdmission.requestedScopes,
        granted_scopes: governance.scopeAdmission.grantedScopes,
        grant_id: governance.scopeAdmission.grantId,
        reasons: governance.scopeAdmission.reasons,
      },
    },
  };
}

export function buildDeniedGraphStepRun(options: {
  readonly step: GraphStep;
  readonly stepSkillPath: string;
  readonly attempt: number;
  readonly parentReceipt?: string;
  readonly fanoutGroup?: string;
  readonly governance: GraphStepGovernance;
  readonly context: readonly MaterializedContextEdge[];
  readonly stderr?: string;
}): GraphStepRun {
  return {
    stepId: options.step.id,
    skill: graphStepReference(options.step),
    skillPath: options.stepSkillPath,
    runner: graphStepRunner(options.step),
    attempt: options.attempt,
    status: "failure",
    stdout: "",
    stderr: options.stderr ?? options.governance.scopeAdmission.reasons?.join("; ") ?? "graph step scope denied",
    parentReceipt: options.parentReceipt,
    fanoutGroup: options.fanoutGroup,
    governance: options.governance,
    artifactIds: [],
    disposition: "policy_denied",
    outcomeState: "complete",
    contextFrom: options.context.map((edge) => ({
      input: edge.input,
      fromStep: edge.fromStep,
      output: edge.output,
      receiptId: edge.receiptId,
    })),
  };
}

export async function writePolicyDeniedGraphReceipt(options: {
  readonly receiptDir: string;
  readonly runxHome?: string;
  readonly graph: ExecutionGraph;
  readonly graphId: string;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly stepRuns: readonly GraphStepRun[];
  readonly errorMessage: string;
  readonly executionSemantics: NormalizedExecutionSemantics;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
}): Promise<LocalGraphReceipt> {
  return await writeLocalGraphReceipt({
    receiptDir: options.receiptDir,
    runxHome: options.runxHome,
    graphId: options.graphId,
    graphName: options.graph.name,
    owner: options.graph.owner,
    status: "failure",
    inputs: options.inputs,
    output: "",
    steps: options.stepRuns.map(toGraphReceiptStep),
    startedAt: options.startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - options.startedAtMs,
    errorMessage: options.errorMessage,
    disposition: "policy_denied",
    inputContext: options.executionSemantics.inputContext,
    outcomeState: options.executionSemantics.outcomeState,
    outcome: options.executionSemantics.outcome,
    surfaceRefs: options.executionSemantics.surfaceRefs,
    evidenceRefs: options.executionSemantics.evidenceRefs,
    metadata: options.receiptMetadata,
  });
}

export function toGraphReceiptStep(step: GraphStepRun): GraphReceiptStep {
  return {
    step_id: step.stepId,
    attempt: step.attempt,
    skill: step.skill,
    runner: step.runner,
    status: step.status,
    receipt_id: step.receiptId,
    parent_receipt: step.parentReceipt,
    fanout_group: step.fanoutGroup,
    retry: step.retry
      ? {
        attempt: step.retry.attempt,
        max_attempts: step.retry.maxAttempts,
        rule_fired: step.retry.ruleFired,
        idempotency_key_hash: step.retry.idempotencyKeyHash,
      }
      : undefined,
    context_from: step.contextFrom.map((edge) => ({
      input: edge.input,
      from_step: edge.fromStep,
      output: edge.output,
      receipt_id: edge.receiptId,
    })),
    governance: step.governance ? toReceiptGovernance(step.governance) : undefined,
    artifact_ids: step.artifactIds && step.artifactIds.length > 0 ? step.artifactIds : undefined,
    disposition: step.disposition,
    input_context: step.inputContext,
    outcome_state: step.outcomeState,
    outcome: step.outcome,
    surface_refs: step.surfaceRefs,
    evidence_refs: step.evidenceRefs,
  };
}

function toReceiptGovernance(governance: GraphStepGovernance): GraphReceiptStep["governance"] {
  return {
    scope_admission: {
      status: governance.scopeAdmission.status,
      requested_scopes: [...governance.scopeAdmission.requestedScopes],
      granted_scopes: [...governance.scopeAdmission.grantedScopes],
      grant_id: governance.scopeAdmission.grantId,
      reasons: governance.scopeAdmission.reasons ? [...governance.scopeAdmission.reasons] : undefined,
    },
  };
}

export function toGraphReceiptSyncPoint(
  decision: FanoutSyncDecision,
  branchReceipts: readonly string[],
): GraphReceiptSyncPoint {
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

export function latestFanoutReceiptIds(stepRuns: readonly GraphStepRun[], groupId: string): readonly string[] {
  const latest = new Map<string, string>();
  for (const stepRun of stepRuns) {
    if (stepRun.fanoutGroup === groupId && stepRun.receiptId) {
      latest.set(stepRun.stepId, stepRun.receiptId);
    }
  }
  return Array.from(latest.values());
}
