import type { ArtifactEnvelope } from "@runxhq/core/artifacts";
import { validateResolutionRequest, type ResolutionRequest } from "@runxhq/core/executor";
import type { ExecutionGraph, GraphStep } from "@runxhq/core/parser";
import type { GraphReceiptSyncPoint } from "@runxhq/core/receipts";
import type { FanoutSyncDecision } from "@runxhq/core/state-machine";

export interface PendingFanoutGate {
  readonly gateKey: string;
  readonly groupId: string;
  readonly request: Extract<ResolutionRequest, { readonly kind: "approval" }>;
  readonly syncPoint: GraphReceiptSyncPoint;
  readonly stepIds: readonly string[];
  readonly stepLabels: readonly string[];
}

export function buildFanoutGateResolutionRequest(
  decision: FanoutSyncDecision,
): Extract<ResolutionRequest, { readonly kind: "approval" }> {
  const id = `fanout.${normalizeResolutionId(decision.groupId)}.${normalizeResolutionId(decision.ruleFired)}`;
  return {
    id,
    kind: "approval",
    gate: {
      id,
      type: decision.decision === "escalate" ? "fanout-escalation" : "fanout-gate",
      reason: decision.reason,
      summary: {
        group_id: decision.groupId,
        decision: decision.decision,
        strategy: decision.strategy,
        rule_fired: decision.ruleFired,
        branch_count: decision.branchCount,
        success_count: decision.successCount,
        failure_count: decision.failureCount,
        required_successes: decision.requiredSuccesses,
        gate: decision.gate,
      },
    },
  };
}

export function fanoutGateReceiptMetadata(
  decision: FanoutSyncDecision,
  status: "escalated",
): Readonly<Record<string, unknown>> {
  return {
    runx: {
      fanout_gate: {
        status,
        group_id: decision.groupId,
        decision: decision.decision,
        strategy: decision.strategy,
        rule_fired: decision.ruleFired,
        reason: decision.reason,
        branch_count: decision.branchCount,
        success_count: decision.successCount,
        failure_count: decision.failureCount,
        required_successes: decision.requiredSuccesses,
        gate: decision.gate,
      },
    },
  };
}

export function readPendingFanoutGate(entries: readonly ArtifactEnvelope[]): PendingFanoutGate | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "run_event") {
      continue;
    }
    const kind = typeof entry.data.kind === "string" ? entry.data.kind : "";
    if (kind === "graph_completed" || kind === "run_completed" || kind === "run_failed") {
      return undefined;
    }
    if (kind !== "step_waiting_resolution" || !isRecord(entry.data.detail)) {
      continue;
    }
    const detail = entry.data.detail;
    const gateKey = typeof detail.fanout_gate_key === "string" ? detail.fanout_gate_key : undefined;
    const syncPoint = parseGraphReceiptSyncPoint(detail.sync_decision);
    if (!gateKey || !syncPoint) {
      continue;
    }
    const requests = Array.isArray(detail.requests)
      ? detail.requests.map((request, requestIndex) =>
          validateResolutionRequest(request, `fanout_gate.requests[${requestIndex}]`))
      : [];
    const request = requests.find((candidate): candidate is Extract<ResolutionRequest, { readonly kind: "approval" }> =>
      candidate.kind === "approval");
    if (!request) {
      continue;
    }
    return {
      gateKey,
      groupId: syncPoint.group_id,
      request,
      syncPoint,
      stepIds: stringArray(detail.step_ids),
      stepLabels: stringArray(detail.step_labels),
    };
  }
  return undefined;
}

export function firstFanoutStep(graph: ExecutionGraph, groupId: string): GraphStep | undefined {
  return graph.steps.find((step) => step.fanoutGroup === groupId);
}

function parseGraphReceiptSyncPoint(value: unknown): GraphReceiptSyncPoint | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const groupId = stringValue(value.group_id);
  const strategy = stringValue(value.strategy);
  const decision = stringValue(value.decision);
  const ruleFired = stringValue(value.rule_fired);
  const reason = stringValue(value.reason);
  if (
    !groupId ||
    !ruleFired ||
    !reason ||
    (strategy !== "all" && strategy !== "any" && strategy !== "quorum") ||
    (decision !== "proceed" && decision !== "halt" && decision !== "pause" && decision !== "escalate")
  ) {
    return undefined;
  }
  return {
    group_id: groupId,
    strategy,
    decision,
    rule_fired: ruleFired,
    reason,
    branch_count: numberValue(value.branch_count),
    success_count: numberValue(value.success_count),
    failure_count: numberValue(value.failure_count),
    required_successes: numberValue(value.required_successes),
    branch_receipts: stringArray(value.branch_receipts),
    gate: isRecord(value.gate) ? value.gate : undefined,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function normalizeResolutionId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}
