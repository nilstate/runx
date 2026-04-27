import {
  materializeArtifacts,
} from "@runxhq/core/artifacts";
import type { ResolutionRequest } from "@runxhq/core/executor";
import type { GraphStep, ValidatedSkill } from "@runxhq/core/parser";
import { admitRetryPolicy } from "@runxhq/core/policy";
import {
  evaluateFanoutSync,
  planSequentialGraphTransition,
  transitionSequentialGraph,
  type SequentialGraphPlan,
} from "@runxhq/core/state-machine";

import { runFanout } from "../fanout.js";
import { findGraphStep, materializeContext } from "../graph-context.js";
import {
  appendGraphLedgerEntries,
  appendGraphStepFailureLedgerEntry,
  appendGraphStepStartedLedgerEntry,
  appendPendingGraphLedgerEntry,
} from "../graph-ledger.js";
import {
  graphProducerSkillName,
  graphStepExecutionDirectory,
  graphStepRunner,
  reportGraphStepCompleted,
  reportGraphStepStarted,
  reportGraphStepWaitingResolution,
} from "../graph-reporting.js";
import {
  buildDeniedGraphStepRun,
  buildGraphStepGovernance,
  governanceReceiptMetadata,
  latestFanoutReceiptIds,
  toGraphReceiptSyncPoint,
  writePolicyDeniedGraphReceipt,
} from "../graph-governance.js";
import { admitGraphTransition, resolveSequentialGraphFailureReason } from "../graph-hydration.js";
import { resolveGraphStepExecution } from "../execution-targets.js";
import { materializeDeclaredInputs } from "../inputs.js";
import {
  buildRetryReceiptContext,
  isAgentMediatedSource,
  mergeMetadata,
} from "../runner-helpers.js";
import { runValidatedSkill, type GraphStepRun, type RunLocalGraphOptions } from "../index.js";

import type { HandlerContinuation, RunContext } from "./run-context.js";

type RunFanoutPlan = Extract<SequentialGraphPlan, { type: "run_fanout" }>;

interface BranchPrep {
  readonly step: GraphStep;
  readonly stepSkillPath: string;
  readonly stepSkill: ValidatedSkill;
  readonly stepReference: string;
  readonly stepInputs: Readonly<Record<string, unknown>>;
  readonly context: ReturnType<typeof materializeContext>;
  readonly contextFromReceiptIds: string[];
  readonly governance: ReturnType<typeof buildGraphStepGovernance>;
  readonly retryContext: ReturnType<typeof buildRetryReceiptContext>;
}

export async function handleRunFanoutPlan(
  ctx: RunContext,
  plan: RunFanoutPlan,
  options: RunLocalGraphOptions,
): Promise<HandlerContinuation> {
  const fanoutParentReceipt = ctx.lastReceiptId;

  const branchPreps: BranchPrep[] = [];

  for (const stepId of plan.stepIds) {
    const step = findGraphStep(ctx.graph, stepId);
    const context = materializeContext(step, ctx.outputs);
    const contextFromReceiptIds = context
      .map((edge) => edge.receiptId)
      .filter((receiptId): receiptId is string => typeof receiptId === "string");
    const resolvedStep = await resolveGraphStepExecution({
      step,
      graphDirectory: ctx.graphDirectory,
      graphStepCache: ctx.graphStepCache,
      skillEnvironment: options.skillEnvironment,
      registryStore: options.registryStore,
      skillCacheDir: options.skillCacheDir,
      toolCatalogAdapters: options.toolCatalogAdapters,
      officialSkillResolver: options.officialSkillResolver,
    });
    const stepSkillPath = resolvedStep.skillPath;
    const stepSkill = resolvedStep.skill;
    ctx.involvedAgentMediatedWork ||= isAgentMediatedSource(stepSkill.source.type);
    const stepInputs = materializeDeclaredInputs(stepSkill.inputs, {
      ...(options.inputs ?? {}),
      ...step.inputs,
      ...Object.fromEntries(context.map((edge) => [edge.input, edge.value])),
    });
    const governance = buildGraphStepGovernance(step, ctx.graphGrant);
    const transitionGate = admitGraphTransition(ctx.graph.policy, step.id, ctx.outputs);
    if (transitionGate.status === "deny") {
      const deniedRun = buildDeniedGraphStepRun({
        step,
        stepSkillPath,
        attempt: plan.attempts[step.id] ?? 1,
        parentReceipt: fanoutParentReceipt,
        fanoutGroup: plan.groupId,
        governance,
        context,
        stderr: transitionGate.reason,
      });
      const receipt = await writePolicyDeniedGraphReceipt({
        receiptDir: ctx.receiptDir,
        runxHome: options.runxHome ?? options.env?.RUNX_HOME,
        graph: ctx.graph,
        graphId: ctx.graphId,
        startedAt: ctx.startedAt,
        startedAtMs: ctx.startedAtMs,
        inputs: options.inputs ?? {},
        stepRuns: [...ctx.stepRuns, deniedRun],
        errorMessage: transitionGate.reason,
        executionSemantics: ctx.executionSemantics,
        receiptMetadata: ctx.inheritedReceiptMetadata,
      });
      return {
        kind: "return",
        result: {
          status: "policy_denied",
          graph: ctx.graph,
          stepId: step.id,
          skill: stepSkill,
          reasons: [transitionGate.reason],
          state: ctx.state,
          receipt,
        },
      };
    }

    if (governance.scopeAdmission.status === "deny") {
      const deniedRun = buildDeniedGraphStepRun({
        step, stepSkillPath,
        attempt: plan.attempts[step.id] ?? 1,
        parentReceipt: fanoutParentReceipt,
        fanoutGroup: plan.groupId,
        governance, context,
      });
      const receipt = await writePolicyDeniedGraphReceipt({
        receiptDir: ctx.receiptDir,
        runxHome: options.runxHome ?? options.env?.RUNX_HOME,
        graph: ctx.graph,
        graphId: ctx.graphId,
        startedAt: ctx.startedAt,
        startedAtMs: ctx.startedAtMs,
        inputs: options.inputs ?? {},
        stepRuns: [...ctx.stepRuns, deniedRun],
        errorMessage: governance.scopeAdmission.reasons?.join("; ") ?? "graph step scope denied",
        executionSemantics: ctx.executionSemantics,
        receiptMetadata: ctx.inheritedReceiptMetadata,
      });
      return {
        kind: "return",
        result: {
          status: "policy_denied",
          graph: ctx.graph,
          stepId: step.id,
          skill: stepSkill,
          reasons: governance.scopeAdmission.reasons ?? [],
          state: ctx.state,
          receipt,
        },
      };
    }

    const effectiveRetry = step.retry ?? stepSkill.retry;
    const retryContext = buildRetryReceiptContext(step, stepInputs, plan.attempts[step.id] ?? 1, stepSkill, effectiveRetry);
    const retryAdmission = admitRetryPolicy({
      stepId: step.id, retry: effectiveRetry,
      mutating: step.mutating || stepSkill.mutating === true,
      idempotencyKey: retryContext.idempotencyKey,
    });
    if (retryAdmission.status === "deny") {
      return {
        kind: "return",
        result: {
          status: "policy_denied",
          graph: ctx.graph,
          stepId: step.id,
          skill: stepSkill,
          reasons: retryAdmission.reasons,
          state: ctx.state,
        },
      };
    }

    branchPreps.push({
      step,
      stepSkillPath,
      stepSkill,
      stepReference: resolvedStep.reference,
      stepInputs,
      context,
      contextFromReceiptIds,
      governance,
      retryContext,
    });
  }

  for (const prep of branchPreps) {
    const stepStartedAt = new Date().toISOString();
    ctx.state = transitionSequentialGraph(ctx.state, {
      type: "start_step",
      stepId: prep.step.id,
      at: stepStartedAt,
    });
    await reportGraphStepStarted(options.caller, prep.step, prep.stepReference);
    await appendGraphStepStartedLedgerEntry({
      receiptDir: ctx.receiptDir,
      runId: ctx.graphId,
      topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, ctx.graph.name),
      step: prep.step,
      reference: prep.stepReference,
      createdAt: stepStartedAt,
    });
  }

  const branchTasks = branchPreps.map((prep) => ({
    id: prep.step.id,
    fn: async (_signal: AbortSignal) => {
      return await runValidatedSkill({
        skill: prep.stepSkill,
        skillDirectory: graphStepExecutionDirectory(prep.step, prep.stepSkillPath, ctx.graphDirectory),
        requestedSkillPath: prep.stepReference,
        inputs: prep.stepInputs,
        caller: options.caller,
        env: options.env,
        receiptDir: ctx.receiptDir,
        runxHome: options.runxHome,
        knowledgeDir: options.knowledgeDir,
        parentReceipt: fanoutParentReceipt,
        contextFrom: prep.contextFromReceiptIds,
        adapters: options.adapters,
        allowedSourceTypes: options.allowedSourceTypes,
        authResolver: options.authResolver,
        receiptMetadata: mergeMetadata(
          ctx.inheritedReceiptMetadata,
          prep.retryContext.receiptMetadata,
          governanceReceiptMetadata(prep.step, prep.governance),
        ),
        orchestrationRunId: ctx.graphId,
        orchestrationStepId: prep.step.id,
        currentContext: prep.context,
        registryStore: options.registryStore,
        skillCacheDir: options.skillCacheDir,
        toolCatalogAdapters: options.toolCatalogAdapters,
        context: ctx.contextSnapshot,
        voiceProfile: ctx.voiceProfile,
        voiceProfilePath: options.voiceProfilePath,
        workspacePolicy: ctx.workspacePolicy,
      });
    },
  }));

  const fanoutResults = await runFanout(branchTasks);
  const pendingResolutionRequests: ResolutionRequest[] = [];
  const pendingStepIds: string[] = [];
  const pendingStepLabels: string[] = [];

  for (let i = 0; i < branchPreps.length; i++) {
    const prep = branchPreps[i];
    const result = fanoutResults[i];

    if (result.status === "aborted" || !result.value) {
      ctx.state = transitionSequentialGraph(ctx.state, {
        type: "step_failed", stepId: prep.step.id,
        at: new Date().toISOString(),
        error: result.error ?? "fanout branch aborted",
      });
      continue;
    }

    const stepResult = result.value;

    if (stepResult.status === "needs_resolution") {
      pendingResolutionRequests.push(...stepResult.requests);
      pendingStepIds.push(prep.step.id);
      pendingStepLabels.push(prep.step.label ?? prep.step.id);
      await reportGraphStepWaitingResolution(
        options.caller,
        prep.step,
        prep.stepReference,
        stepResult.requests,
      );
      await appendPendingGraphLedgerEntry({
        receiptDir: ctx.receiptDir,
        runId: ctx.graphId,
        topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, ctx.graph.name),
        stepId: prep.step.id,
        kind: "step_waiting_resolution",
        detail: {
          request_ids: stepResult.requests.map((request) => request.id),
          resolution_kinds: Array.from(new Set(stepResult.requests.map((request) => request.kind))),
          requests: stepResult.requests,
          runner: graphStepRunner(prep.step) ?? "default",
          step_label: prep.step.label,
        },
        createdAt: new Date().toISOString(),
      });
      continue;
    }

    if (stepResult.status === "policy_denied") {
      await reportGraphStepCompleted(
        options.caller,
        prep.step,
        prep.stepReference,
        "failure",
        {
          reason: `policy denied: ${stepResult.reasons.join("; ")}`,
        },
      );
      await appendGraphStepFailureLedgerEntry({
        receiptDir: ctx.receiptDir,
        runId: ctx.graphId,
        topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, ctx.graph.name),
        stepId: prep.step.id,
        reason: `policy denied: ${stepResult.reasons.join("; ")}`,
      });
      ctx.state = transitionSequentialGraph(ctx.state, {
        type: "step_failed", stepId: prep.step.id,
        at: new Date().toISOString(),
        error: `policy denied: ${stepResult.reasons.join("; ")}`,
      });
      continue;
    }

    const stepCompletedAt = new Date().toISOString();
    const artifactResult = materializeArtifacts({
      stdout: stepResult.execution.stdout,
      contract: stepResult.skill.artifacts,
      runId: ctx.graphId,
      stepId: prep.step.id,
      producer: {
        skill: stepResult.skill.name,
        runner: stepResult.skill.source.type,
      },
      createdAt: stepCompletedAt,
    });
    const stepRun: GraphStepRun = {
      stepId: prep.step.id,
      skill: prep.stepReference,
      skillPath: prep.stepSkillPath,
      runner: graphStepRunner(prep.step),
      attempt: plan.attempts[prep.step.id] ?? 1,
      status: stepResult.status,
      receiptId: stepResult.receipt.id,
      stdout: stepResult.execution.stdout,
      stderr: stepResult.execution.stderr,
      parentReceipt: fanoutParentReceipt,
      fanoutGroup: plan.groupId,
      retry: prep.retryContext.receipt,
      governance: prep.governance,
      artifactIds: artifactResult.envelopes.map((envelope) => envelope.meta.artifact_id),
      disposition: stepResult.receipt.disposition,
      inputContext: stepResult.receipt.input_context,
      outcomeState: stepResult.receipt.outcome_state,
      outcome: stepResult.receipt.outcome,
      surfaceRefs: stepResult.receipt.surface_refs,
      evidenceRefs: stepResult.receipt.evidence_refs,
      contextFrom: prep.context.map((edge) => ({
        input: edge.input, fromStep: edge.fromStep,
        output: edge.output, receiptId: edge.receiptId,
      })),
    };
    ctx.stepRuns.push(stepRun);
    ctx.outputs.set(prep.step.id, {
      status: stepResult.status,
      stdout: stepResult.execution.stdout,
      stderr: stepResult.execution.stderr,
      receiptId: stepResult.receipt.id,
      fields: artifactResult.fields,
      artifactIds: artifactResult.envelopes.map((envelope) => envelope.meta.artifact_id),
      artifacts: artifactResult.envelopes,
    });
    ctx.finalOutput = stepResult.execution.stdout;
    await appendGraphLedgerEntries({
      receiptDir: ctx.receiptDir,
      runId: ctx.graphId,
      topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, ctx.graph.name),
      stepId: prep.step.id,
      skill: stepResult.skill,
      artifactEnvelopes: artifactResult.envelopes,
      receiptId: stepResult.receipt.id,
      status: stepResult.status,
      detail: {
        runner: graphStepRunner(prep.step) ?? "default",
      },
      createdAt: stepCompletedAt,
    });

    ctx.state = stepResult.status === "success"
      ? transitionSequentialGraph(ctx.state, {
          type: "step_succeeded", stepId: prep.step.id,
          at: stepCompletedAt, receiptId: stepResult.receipt.id,
          outputs: artifactResult.fields,
        })
      : transitionSequentialGraph(ctx.state, {
          type: "step_failed", stepId: prep.step.id,
          at: stepCompletedAt,
          error: stepResult.execution.errorMessage ?? stepResult.execution.stderr,
        });
    await reportGraphStepCompleted(
      options.caller,
      prep.step,
      prep.stepReference,
      stepResult.status,
      {
        receiptId: stepResult.receipt.id,
      },
    );
  }

  if (pendingResolutionRequests.length > 0) {
    return {
      kind: "return",
      result: {
        status: "needs_resolution",
        graph: ctx.graph,
        stepIds: pendingStepIds,
        stepLabels: pendingStepLabels,
        skillPath: branchPreps.find((prep) => pendingStepIds.includes(prep.step.id))?.stepSkillPath ?? ctx.graphDirectory,
        skill: branchPreps.find((prep) => pendingStepIds.includes(prep.step.id))?.stepSkill ?? branchPreps[0]!.stepSkill,
        requests: pendingResolutionRequests,
        state: ctx.state,
        runId: ctx.graphId,
      },
    };
  }

  const followUpPlan = planSequentialGraphTransition(ctx.state, ctx.graphSteps, ctx.graph.fanoutGroups, {
    resolvedFanoutGateKeys: ctx.resolvedFanoutGateKeys,
  });
  if (followUpPlan.type === "run_fanout" && followUpPlan.groupId === plan.groupId) {
    return { kind: "continue" };
  }
  if ((followUpPlan.type === "failed" || followUpPlan.type === "blocked") && followUpPlan.syncDecision?.groupId === plan.groupId) {
    ctx.finalError =
      followUpPlan.type === "failed"
        ? resolveSequentialGraphFailureReason(followUpPlan, ctx.state, ctx.stepRuns)
        : followUpPlan.reason;
    ctx.syncPoints.push(toGraphReceiptSyncPoint(followUpPlan.syncDecision, latestFanoutReceiptIds(ctx.stepRuns, plan.groupId)));
    ctx.state = transitionSequentialGraph(ctx.state, { type: "fail_graph", error: ctx.finalError });
    return { kind: "break" };
  }
  if ((followUpPlan.type === "paused" || followUpPlan.type === "escalated") && followUpPlan.syncDecision.groupId === plan.groupId) {
    const groupReceiptIds = latestFanoutReceiptIds(ctx.stepRuns, plan.groupId);
    ctx.lastReceiptId = groupReceiptIds[groupReceiptIds.length - 1] ?? ctx.lastReceiptId;
    return { kind: "continue" };
  }

  const policy = ctx.graph.fanoutGroups[plan.groupId];
  if (policy) {
    const decision = evaluateFanoutSync(
      policy,
      ctx.graphSteps
        .filter((step) => step.fanoutGroup === plan.groupId)
        .map((step) => {
          const stepState = ctx.state.steps.find((candidate) => candidate.stepId === step.id);
          return {
            stepId: step.id,
            status: stepState?.status ?? "failed",
            outputs: stepState?.outputs,
          };
        }),
      { resolvedGateKeys: ctx.resolvedFanoutGateKeys },
    );
    if (decision.decision === "proceed" || decision.decision === "halt") {
      ctx.syncPoints.push(toGraphReceiptSyncPoint(decision, latestFanoutReceiptIds(ctx.stepRuns, plan.groupId)));
    }
  }

  const groupReceiptIds = latestFanoutReceiptIds(ctx.stepRuns, plan.groupId);
  ctx.lastReceiptId = groupReceiptIds[groupReceiptIds.length - 1] ?? ctx.lastReceiptId;
  return { kind: "continue" };
}
