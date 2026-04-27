import {
  fanoutSyncDecisionKey,
  transitionSequentialGraph,
  type SequentialGraphPlan,
} from "@runxhq/core/state-machine";

import { findGraphStep } from "../graph-context.js";
import { resolveGraphStepExecution } from "../execution-targets.js";
import {
  appendPendingGraphLedgerEntry,
} from "../graph-ledger.js";
import {
  graphProducerSkillName,
} from "../graph-reporting.js";
import {
  buildFanoutGateResolutionRequest,
} from "../graph-fanout-gates.js";
import {
  latestFanoutReceiptIds,
  toGraphReceiptSyncPoint,
} from "../graph-governance.js";
import type { RunLocalGraphOptions } from "../index.js";

import type { HandlerContinuation, RunContext } from "./run-context.js";

type PausedPlan = Extract<SequentialGraphPlan, { type: "paused" }>;

export async function handlePausedPlan(
  ctx: RunContext,
  plan: PausedPlan,
  options: RunLocalGraphOptions,
): Promise<HandlerContinuation> {
  const gateRequest = buildFanoutGateResolutionRequest(plan.syncDecision);
  await options.caller.report({
    type: "resolution_requested",
    message: plan.syncDecision.reason,
    data: {
      kind: gateRequest.kind,
      requestId: gateRequest.id,
      gate: gateRequest.gate,
    },
  });
  const resolution = await options.caller.resolve(gateRequest);

  if (resolution === undefined) {
    const stepIds = ctx.graphSteps
      .filter((step) => step.fanoutGroup === plan.syncDecision.groupId)
      .map((step) => step.id);
    const stepLabels = ctx.graph.steps
      .filter((step) => step.fanoutGroup === plan.syncDecision.groupId)
      .map((step) => step.label ?? step.id);
    const pendingStep = findGraphStep(ctx.graph, plan.stepId);
    const resolvedStep = await resolveGraphStepExecution({
      step: pendingStep,
      graphDirectory: ctx.graphDirectory,
      graphStepCache: ctx.graphStepCache,
      skillEnvironment: options.skillEnvironment,
      registryStore: options.registryStore,
      skillCacheDir: options.skillCacheDir,
      toolCatalogAdapters: options.toolCatalogAdapters,
      officialSkillResolver: options.officialSkillResolver,
    });
    await appendPendingGraphLedgerEntry({
      receiptDir: ctx.receiptDir,
      runId: ctx.graphId,
      topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, ctx.graph.name),
      stepId: `fanout:${plan.syncDecision.groupId}`,
      kind: "step_waiting_resolution",
      detail: {
        request_ids: [gateRequest.id],
        resolution_kinds: [gateRequest.kind],
        requests: [gateRequest],
        runner: "graph",
        step_label: `fanout ${plan.syncDecision.groupId}`,
        step_ids: stepIds,
        step_labels: stepLabels,
        inputs: options.inputs ?? {},
        skill_path: ctx.graphResolution.resolvedGraphPath ?? ctx.graphDirectory,
        resolved_path: ctx.graphResolution.resolvedGraphPath ?? ctx.graphDirectory,
        fanout_gate_key: fanoutSyncDecisionKey(plan.syncDecision),
        sync_decision: toGraphReceiptSyncPoint(
          plan.syncDecision,
          latestFanoutReceiptIds(ctx.stepRuns, plan.syncDecision.groupId),
        ),
      },
      createdAt: new Date().toISOString(),
    });
    ctx.state = transitionSequentialGraph(ctx.state, { type: "pause_graph", reason: plan.reason });
    return {
      kind: "return",
      result: {
        status: "needs_resolution",
        graph: ctx.graph,
        stepIds,
        stepLabels,
        skillPath: resolvedStep.skillPath,
        skill: resolvedStep.skill,
        requests: [gateRequest],
        state: ctx.state,
        runId: ctx.graphId,
      },
    };
  }

  const approved = typeof resolution.payload === "boolean" ? resolution.payload : Boolean(resolution.payload);
  await options.caller.report({
    type: "resolution_resolved",
    message: approved ? `Fanout gate ${gateRequest.gate.id} approved.` : `Fanout gate ${gateRequest.gate.id} denied.`,
    data: {
      kind: gateRequest.kind,
      requestId: gateRequest.id,
      gate: gateRequest.gate,
      actor: resolution.actor,
      approved,
    },
  });
  ctx.syncPoints.push(toGraphReceiptSyncPoint(plan.syncDecision, latestFanoutReceiptIds(ctx.stepRuns, plan.syncDecision.groupId)));
  if (!approved) {
    ctx.finalError = `fanout gate denied: ${plan.reason}`;
    ctx.state = transitionSequentialGraph(ctx.state, { type: "fail_graph", error: ctx.finalError });
    return { kind: "break" };
  }

  ctx.resolvedFanoutGateKeys.add(fanoutSyncDecisionKey(plan.syncDecision));
  return { kind: "continue" };
}
