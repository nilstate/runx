import {
  materializeArtifacts,
  readLedgerEntries,
  type ArtifactEnvelope,
} from "../artifacts/index.js";
import { validateResolutionRequest, type ResolutionRequest } from "../executor/index.js";
import {
  loadRunxWorkspacePolicy,
} from "../config/index.js";
import {
  contextReceiptMetadata,
  loadContext,
  loadVoiceProfile,
  voiceProfileReceiptMetadata,
} from "./context.js";
import type { ExecutionGraph, GraphStep, ValidatedSkill } from "../parser/index.js";
import { admitRetryPolicy } from "../policy/index.js";
import {
  uniqueReceiptId,
  writeLocalGraphReceipt,
  type GraphReceiptSyncPoint,
} from "../receipts/index.js";
import {
  createSequentialGraphState,
  evaluateFanoutSync,
  fanoutSyncDecisionKey,
  planSequentialGraphTransition,
  transitionSequentialGraph,
  type FanoutSyncDecision,
  type SequentialGraphState,
} from "../state-machine/index.js";
import { runFanout } from "./fanout.js";
import { findGraphStep, materializeContext, type GraphStepOutput } from "./graph-context.js";
import {
  appendGraphCompletedLedgerEntry,
  appendGraphLedgerEntries,
  appendGraphStepFailureLedgerEntry,
  appendGraphStepStartedLedgerEntry,
  appendPendingGraphLedgerEntry,
} from "./graph-ledger.js";
import {
  graphProducerSkillName,
  graphStepExecutionDirectory,
  graphStepRunner,
  reportGraphStepCompleted,
  reportGraphStepStarted,
  reportGraphStepWaitingResolution,
} from "./graph-reporting.js";
import {
  buildDeniedGraphStepRun,
  buildGraphStepGovernance,
  governanceReceiptMetadata,
  latestFanoutReceiptIds,
  toGraphReceiptStep,
  toGraphReceiptSyncPoint,
  writePolicyDeniedGraphReceipt,
} from "./graph-governance.js";
import { materializeDeclaredInputs } from "./inputs.js";
import { defaultReceiptDir } from "./receipt-paths.js";
import {
  loadGraphStepExecutables,
  resolveGraphExecution,
  resolveGraphStepExecution,
} from "./execution-targets.js";
import {
  admitGraphTransition,
  hydrateGraphFromLedger,
  resolveSequentialGraphFailureReason,
} from "./graph-hydration.js";
import { projectReflectIfEnabled } from "./reflect.js";
import {
  buildRetryReceiptContext,
  defaultLocalGraphGrant,
  indexReceiptIfEnabled,
  isAgentMediatedSource,
  mergeMetadata,
  unique,
} from "./runner-helpers.js";
import { normalizeExecutionSemantics } from "./execution-semantics.js";
import { runValidatedSkill, type GraphStepRun, type RunLocalGraphOptions, type RunLocalGraphResult } from "./index.js";

export async function runLocalGraph(options: RunLocalGraphOptions): Promise<RunLocalGraphResult> {
  const graphResolution = await resolveGraphExecution(options);
  const workspacePolicy = options.workspacePolicy ?? await loadRunxWorkspacePolicy(options.env ?? process.env);
  const receiptDir = options.receiptDir ?? defaultReceiptDir(options.env);
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const executionSemantics = normalizeExecutionSemantics(options.executionSemantics, options.inputs ?? {});
  const graph = graphResolution.graph;
  const graphDirectory = graphResolution.graphDirectory;
  const contextSnapshot =
    options.context
    ?? (await loadContext({
      inputs: options.inputs ?? {},
      env: options.env,
      fallbackStart: graphDirectory,
    }));
  const voiceProfile =
    options.voiceProfile
    ?? (await loadVoiceProfile({
      env: options.env,
      voiceProfilePath: options.voiceProfilePath,
    }));
  const inheritedReceiptMetadata = mergeMetadata(
    contextReceiptMetadata(contextSnapshot),
    voiceProfileReceiptMetadata(voiceProfile),
    options.receiptMetadata,
  );
  const graphId = options.runId ?? options.resumeFromRunId ?? uniqueReceiptId("gx");
  const graphStepCache = await loadGraphStepExecutables(
    graph,
    graphDirectory,
    options.registryStore,
    options.skillCacheDir,
    options.toolCatalogAdapters,
  );
  const graphGrant = options.graphGrant ?? defaultLocalGraphGrant();
  const graphSteps = graph.steps.map((step) => ({
    id: step.id,
    contextFrom: unique(step.contextEdges.map((edge) => edge.fromStep)),
    retry: step.retry ?? graphStepCache.get(step.id)?.retry,
    fanoutGroup: step.fanoutGroup,
  }));
  let state = createSequentialGraphState(graphId, graphSteps);
  const stepRuns: GraphStepRun[] = [];
  const syncPoints: GraphReceiptSyncPoint[] = [];
  const resolvedFanoutGateKeys = new Set<string>();
  const outputs = new Map<string, GraphStepOutput>();
  let lastReceiptId: string | undefined;
  let finalOutput = "";
  let finalError: string | undefined;
  let terminalReceiptMetadata: Readonly<Record<string, unknown>> | undefined;
  let graphAlreadyTerminal = false;
  let involvedAgentMediatedWork = false;
  if (options.resumeFromRunId) {
    const resumeEntries = await readLedgerEntries(receiptDir, options.resumeFromRunId);
    hydrateGraphFromLedger({
      entries: resumeEntries,
      graph,
      graphStepCache,
      skillEnvironment: options.skillEnvironment,
      graphSteps,
      stepRuns,
      outputs,
      syncPoints,
      stateRef: {
        get value() {
          return state;
        },
        set value(next: SequentialGraphState) {
          state = next;
        },
      },
      lastReceiptRef: {
        get value() {
          return lastReceiptId;
        },
        set value(next: string | undefined) {
          lastReceiptId = next;
        },
      },
    });
    const pendingFanoutGate = readPendingFanoutGate(resumeEntries);
    if (pendingFanoutGate) {
      syncPoints.push(pendingFanoutGate.syncPoint);
      const resolution = await options.caller.resolve(pendingFanoutGate.request);
      if (resolution === undefined) {
        const pendingStep = firstFanoutStep(graph, pendingFanoutGate.groupId);
        if (!pendingStep) {
          throw new Error(`Unable to resume fanout gate for unknown group '${pendingFanoutGate.groupId}'.`);
        }
        const resolvedStep = await resolveGraphStepExecution({
          step: pendingStep,
          graphDirectory,
          graphStepCache,
          skillEnvironment: options.skillEnvironment,
          registryStore: options.registryStore,
          skillCacheDir: options.skillCacheDir,
          toolCatalogAdapters: options.toolCatalogAdapters,
        });
        return {
          status: "needs_resolution",
          graph,
          stepIds: pendingFanoutGate.stepIds,
          stepLabels: pendingFanoutGate.stepLabels,
          skillPath: resolvedStep.skillPath,
          skill: resolvedStep.skill,
          requests: [pendingFanoutGate.request],
          state,
          runId: graphId,
        };
      }
      const approved = typeof resolution.payload === "boolean" ? resolution.payload : Boolean(resolution.payload);
      if (approved) {
        resolvedFanoutGateKeys.add(pendingFanoutGate.gateKey);
      } else {
        finalError = `fanout gate denied: ${pendingFanoutGate.syncPoint.reason}`;
        state = transitionSequentialGraph(state, { type: "fail_graph", error: finalError });
        graphAlreadyTerminal = true;
      }
    }
    involvedAgentMediatedWork = stepRuns.some((stepRun) => {
      const step = graph.steps.find((candidate) => candidate.id === stepRun.stepId);
      const cachedSkill = graphStepCache.get(stepRun.stepId);
      if (cachedSkill) {
        return isAgentMediatedSource(cachedSkill.source.type);
      }
      return isAgentMediatedSource(String(step?.run?.type ?? ""));
    });
  }

  await options.caller.report({
    type: "skill_loaded",
    message: `Loaded graph ${graph.name}.`,
    data: { graphPath: graphResolution.resolvedGraphPath, graphId },
  });

  while (!graphAlreadyTerminal) {
    const plan = planSequentialGraphTransition(state, graphSteps, graph.fanoutGroups, {
      resolvedFanoutGateKeys,
    });
    if (plan.type === "complete") {
      state = transitionSequentialGraph(state, { type: "complete" });
      break;
    }

    if (plan.type === "failed") {
      finalError = resolveSequentialGraphFailureReason(plan, state, stepRuns);
      if (plan.syncDecision) {
        syncPoints.push(toGraphReceiptSyncPoint(plan.syncDecision, latestFanoutReceiptIds(stepRuns, plan.syncDecision.groupId)));
      }
      state = transitionSequentialGraph(state, { type: "fail_graph", error: finalError });
      break;
    }

    if (plan.type === "blocked") {
      finalError = plan.reason;
      if (plan.syncDecision) {
        syncPoints.push(toGraphReceiptSyncPoint(plan.syncDecision, latestFanoutReceiptIds(stepRuns, plan.syncDecision.groupId)));
      }
      state = transitionSequentialGraph(state, { type: "fail_graph", error: plan.reason });
      break;
    }

    if (plan.type === "escalated") {
      const syncPoint = toGraphReceiptSyncPoint(
        plan.syncDecision,
        latestFanoutReceiptIds(stepRuns, plan.syncDecision.groupId),
      );
      syncPoints.push(syncPoint);
      finalError = `fanout escalation: ${plan.reason}`;
      terminalReceiptMetadata = fanoutGateReceiptMetadata(plan.syncDecision, "escalated");
      await options.caller.report({
        type: "warning",
        message: finalError,
        data: {
          kind: "fanout_escalated",
          syncPoint,
        },
      });
      state = transitionSequentialGraph(state, { type: "escalate_graph", reason: finalError });
      break;
    }

    if (plan.type === "paused") {
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
        const stepIds = graphSteps
          .filter((step) => step.fanoutGroup === plan.syncDecision.groupId)
          .map((step) => step.id);
        const stepLabels = graph.steps
          .filter((step) => step.fanoutGroup === plan.syncDecision.groupId)
          .map((step) => step.label ?? step.id);
        const pendingStep = findGraphStep(graph, plan.stepId);
        const resolvedStep = await resolveGraphStepExecution({
          step: pendingStep,
          graphDirectory,
          graphStepCache,
          skillEnvironment: options.skillEnvironment,
          registryStore: options.registryStore,
          skillCacheDir: options.skillCacheDir,
          toolCatalogAdapters: options.toolCatalogAdapters,
        });
        await appendPendingGraphLedgerEntry({
          receiptDir,
          runId: graphId,
          topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
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
            skill_path: graphResolution.resolvedGraphPath ?? graphDirectory,
            resolved_path: graphResolution.resolvedGraphPath ?? graphDirectory,
            fanout_gate_key: fanoutSyncDecisionKey(plan.syncDecision),
            sync_decision: toGraphReceiptSyncPoint(
              plan.syncDecision,
              latestFanoutReceiptIds(stepRuns, plan.syncDecision.groupId),
            ),
          },
          createdAt: new Date().toISOString(),
        });
        state = transitionSequentialGraph(state, { type: "pause_graph", reason: plan.reason });
        return {
          status: "needs_resolution",
          graph,
          stepIds,
          stepLabels,
          skillPath: resolvedStep.skillPath,
          skill: resolvedStep.skill,
          requests: [gateRequest],
          state,
          runId: graphId,
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
      syncPoints.push(toGraphReceiptSyncPoint(plan.syncDecision, latestFanoutReceiptIds(stepRuns, plan.syncDecision.groupId)));
      if (!approved) {
        finalError = `fanout gate denied: ${plan.reason}`;
        state = transitionSequentialGraph(state, { type: "fail_graph", error: finalError });
        break;
      }

      resolvedFanoutGateKeys.add(fanoutSyncDecisionKey(plan.syncDecision));
      continue;
    }

    if (plan.type === "run_fanout") {
      const fanoutParentReceipt = lastReceiptId;

      // Pre-flight: admission and retry checks (synchronous, before parallel execution)
      const branchPreps: Array<{
        step: GraphStep;
        stepSkillPath: string;
        stepSkill: ValidatedSkill;
        stepReference: string;
        stepInputs: Readonly<Record<string, unknown>>;
        context: ReturnType<typeof materializeContext>;
        contextFromReceiptIds: string[];
        governance: ReturnType<typeof buildGraphStepGovernance>;
        retryContext: ReturnType<typeof buildRetryReceiptContext>;
      }> = [];

      for (const stepId of plan.stepIds) {
        const step = findGraphStep(graph, stepId);
        const context = materializeContext(step, outputs);
        const contextFromReceiptIds = context
          .map((edge) => edge.receiptId)
          .filter((receiptId): receiptId is string => typeof receiptId === "string");
        const resolvedStep = await resolveGraphStepExecution({
          step,
          graphDirectory,
          graphStepCache,
          skillEnvironment: options.skillEnvironment,
          registryStore: options.registryStore,
          skillCacheDir: options.skillCacheDir,
          toolCatalogAdapters: options.toolCatalogAdapters,
        });
        const stepSkillPath = resolvedStep.skillPath;
        const stepSkill = resolvedStep.skill;
        involvedAgentMediatedWork ||= isAgentMediatedSource(stepSkill.source.type);
        const stepInputs = materializeDeclaredInputs(stepSkill.inputs, {
          ...(options.inputs ?? {}),
          ...step.inputs,
          ...Object.fromEntries(context.map((edge) => [edge.input, edge.value])),
        });
        const governance = buildGraphStepGovernance(step, graphGrant);
        const transitionGate = admitGraphTransition(graph.policy, step.id, outputs);
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
            receiptDir,
            runxHome: options.runxHome ?? options.env?.RUNX_HOME,
            graph,
            graphId,
            startedAt,
            startedAtMs,
            inputs: options.inputs ?? {},
            stepRuns: [...stepRuns, deniedRun],
            errorMessage: transitionGate.reason,
            executionSemantics,
            receiptMetadata: inheritedReceiptMetadata,
          });
          return {
            status: "policy_denied",
            graph,
            stepId: step.id,
            skill: stepSkill,
            reasons: [transitionGate.reason],
            state,
            receipt,
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
            receiptDir,
            runxHome: options.runxHome ?? options.env?.RUNX_HOME,
            graph, graphId, startedAt, startedAtMs,
            inputs: options.inputs ?? {},
            stepRuns: [...stepRuns, deniedRun],
            errorMessage: governance.scopeAdmission.reasons?.join("; ") ?? "graph step scope denied",
            executionSemantics,
            receiptMetadata: inheritedReceiptMetadata,
          });
          return {
            status: "policy_denied", graph, stepId: step.id,
            skill: stepSkill,
            reasons: governance.scopeAdmission.reasons ?? [],
            state, receipt,
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
            status: "policy_denied", graph, stepId: step.id,
            skill: stepSkill, reasons: retryAdmission.reasons, state,
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
        state = transitionSequentialGraph(state, {
          type: "start_step",
          stepId: prep.step.id,
          at: stepStartedAt,
        });
        await reportGraphStepStarted(options.caller, prep.step, prep.stepReference);
        await appendGraphStepStartedLedgerEntry({
          receiptDir,
          runId: graphId,
          topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
          step: prep.step,
          reference: prep.stepReference,
          createdAt: stepStartedAt,
        });
      }

      // Parallel execution: all branches run concurrently
      const branchTasks = branchPreps.map((prep) => ({
        id: prep.step.id,
        fn: async (_signal: AbortSignal) => {
          return await runValidatedSkill({
            skill: prep.stepSkill,
            skillDirectory: graphStepExecutionDirectory(prep.step, prep.stepSkillPath, graphDirectory),
            requestedSkillPath: prep.stepReference,
            inputs: prep.stepInputs,
            caller: options.caller,
            env: options.env,
            receiptDir,
            runxHome: options.runxHome,
            knowledgeDir: options.knowledgeDir,
            parentReceipt: fanoutParentReceipt,
            contextFrom: prep.contextFromReceiptIds,
            adapters: options.adapters,
            allowedSourceTypes: options.allowedSourceTypes,
            authResolver: options.authResolver,
            receiptMetadata: mergeMetadata(
              inheritedReceiptMetadata,
              prep.retryContext.receiptMetadata,
              governanceReceiptMetadata(prep.step, prep.governance),
            ),
            orchestrationRunId: graphId,
            orchestrationStepId: prep.step.id,
            currentContext: prep.context,
            registryStore: options.registryStore,
            skillCacheDir: options.skillCacheDir,
            toolCatalogAdapters: options.toolCatalogAdapters,
            context: contextSnapshot,
            voiceProfile,
            voiceProfilePath: options.voiceProfilePath,
            workspacePolicy,
          });
        },
      }));

      const fanoutResults = await runFanout(branchTasks);
      const pendingResolutionRequests: ResolutionRequest[] = [];
      const pendingStepIds: string[] = [];
      const pendingStepLabels: string[] = [];

      // Apply results to state machine in declaration order
      for (let i = 0; i < branchPreps.length; i++) {
        const prep = branchPreps[i];
        const result = fanoutResults[i];

        if (result.status === "aborted" || !result.value) {
          state = transitionSequentialGraph(state, {
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
            receiptDir,
            runId: graphId,
            topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
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

        // In fanout, policy_denied is a branch failure, not a graph halt.
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
            receiptDir,
            runId: graphId,
            topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
            stepId: prep.step.id,
            reason: `policy denied: ${stepResult.reasons.join("; ")}`,
          });
          state = transitionSequentialGraph(state, {
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
          runId: graphId,
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
        stepRuns.push(stepRun);
        outputs.set(prep.step.id, {
          status: stepResult.status,
          stdout: stepResult.execution.stdout,
          stderr: stepResult.execution.stderr,
          receiptId: stepResult.receipt.id,
          fields: artifactResult.fields,
          artifactIds: artifactResult.envelopes.map((envelope) => envelope.meta.artifact_id),
          artifacts: artifactResult.envelopes,
        });
        finalOutput = stepResult.execution.stdout;
        await appendGraphLedgerEntries({
          receiptDir,
          runId: graphId,
          topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
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

        state = stepResult.status === "success"
          ? transitionSequentialGraph(state, {
              type: "step_succeeded", stepId: prep.step.id,
              at: stepCompletedAt, receiptId: stepResult.receipt.id,
              outputs: artifactResult.fields,
            })
          : transitionSequentialGraph(state, {
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
          status: "needs_resolution",
          graph,
          stepIds: pendingStepIds,
          stepLabels: pendingStepLabels,
          skillPath: branchPreps.find((prep) => pendingStepIds.includes(prep.step.id))?.stepSkillPath ?? graphDirectory,
          skill: branchPreps.find((prep) => pendingStepIds.includes(prep.step.id))?.stepSkill ?? branchPreps[0]!.stepSkill,
          requests: pendingResolutionRequests,
          state,
          runId: graphId,
        };
      }

      const followUpPlan = planSequentialGraphTransition(state, graphSteps, graph.fanoutGroups, {
        resolvedFanoutGateKeys,
      });
      if (followUpPlan.type === "run_fanout" && followUpPlan.groupId === plan.groupId) {
        continue;
      }
      if ((followUpPlan.type === "failed" || followUpPlan.type === "blocked") && followUpPlan.syncDecision?.groupId === plan.groupId) {
        finalError =
          followUpPlan.type === "failed"
            ? resolveSequentialGraphFailureReason(followUpPlan, state, stepRuns)
            : followUpPlan.reason;
        syncPoints.push(toGraphReceiptSyncPoint(followUpPlan.syncDecision, latestFanoutReceiptIds(stepRuns, plan.groupId)));
        state = transitionSequentialGraph(state, { type: "fail_graph", error: finalError });
        break;
      }
      if ((followUpPlan.type === "paused" || followUpPlan.type === "escalated") && followUpPlan.syncDecision.groupId === plan.groupId) {
        const groupReceiptIds = latestFanoutReceiptIds(stepRuns, plan.groupId);
        lastReceiptId = groupReceiptIds[groupReceiptIds.length - 1] ?? lastReceiptId;
        continue;
      }

      const policy = graph.fanoutGroups[plan.groupId];
      if (policy) {
        const decision = evaluateFanoutSync(
          policy,
          graphSteps
            .filter((step) => step.fanoutGroup === plan.groupId)
            .map((step) => {
              const stepState = state.steps.find((candidate) => candidate.stepId === step.id);
              return {
                stepId: step.id,
                status: stepState?.status ?? "failed",
                outputs: stepState?.outputs,
              };
            }),
          { resolvedGateKeys: resolvedFanoutGateKeys },
        );
        if (decision.decision === "proceed" || decision.decision === "halt") {
          syncPoints.push(toGraphReceiptSyncPoint(decision, latestFanoutReceiptIds(stepRuns, plan.groupId)));
        }
      }

      const groupReceiptIds = latestFanoutReceiptIds(stepRuns, plan.groupId);
      lastReceiptId = groupReceiptIds[groupReceiptIds.length - 1] ?? lastReceiptId;
      continue;
    }

    const step = findGraphStep(graph, plan.stepId);
    const context = materializeContext(step, outputs);
    const contextFromReceiptIds = context
      .map((edge) => edge.receiptId)
      .filter((receiptId): receiptId is string => typeof receiptId === "string");
    const resolvedStep = await resolveGraphStepExecution({
      step,
      graphDirectory,
      graphStepCache,
      skillEnvironment: options.skillEnvironment,
      registryStore: options.registryStore,
      skillCacheDir: options.skillCacheDir,
      toolCatalogAdapters: options.toolCatalogAdapters,
    });
    const stepSkillPath = resolvedStep.skillPath;
    const stepSkill = resolvedStep.skill;
    involvedAgentMediatedWork ||= isAgentMediatedSource(stepSkill.source.type);
    const stepInputs = materializeDeclaredInputs(stepSkill.inputs, {
      ...(options.inputs ?? {}),
      ...step.inputs,
      ...Object.fromEntries(context.map((edge) => [edge.input, edge.value])),
    });
    const governance = buildGraphStepGovernance(step, graphGrant);
    const transitionGate = admitGraphTransition(graph.policy, step.id, outputs);
    if (transitionGate.status === "deny") {
      const deniedRun = buildDeniedGraphStepRun({
        step,
        stepSkillPath,
        attempt: plan.attempt,
        parentReceipt: lastReceiptId,
        governance,
        context,
        stderr: transitionGate.reason,
      });
      const receipt = await writePolicyDeniedGraphReceipt({
        receiptDir,
        runxHome: options.runxHome ?? options.env?.RUNX_HOME,
        graph,
        graphId,
        startedAt,
        startedAtMs,
        inputs: options.inputs ?? {},
        stepRuns: [...stepRuns, deniedRun],
        errorMessage: transitionGate.reason,
        executionSemantics,
        receiptMetadata: inheritedReceiptMetadata,
      });
      return {
        status: "policy_denied",
        graph,
        stepId: step.id,
        skill: stepSkill,
        reasons: [transitionGate.reason],
        state,
        receipt,
      };
    }
    if (governance.scopeAdmission.status === "deny") {
      const deniedRun = buildDeniedGraphStepRun({
        step,
        stepSkillPath,
        attempt: plan.attempt,
        parentReceipt: lastReceiptId,
        governance,
        context,
      });
      const receipt = await writePolicyDeniedGraphReceipt({
        receiptDir,
        runxHome: options.runxHome ?? options.env?.RUNX_HOME,
        graph,
        graphId,
        startedAt,
        startedAtMs,
        inputs: options.inputs ?? {},
        stepRuns: [...stepRuns, deniedRun],
        errorMessage: governance.scopeAdmission.reasons?.join("; ") ?? "graph step scope denied",
        executionSemantics,
        receiptMetadata: inheritedReceiptMetadata,
      });
      return {
        status: "policy_denied",
        graph,
        stepId: step.id,
        skill: stepSkill,
        reasons: governance.scopeAdmission.reasons ?? [],
        state,
        receipt,
      };
    }
    const effectiveRetry = step.retry ?? stepSkill.retry;
    const retryContext = buildRetryReceiptContext(step, stepInputs, plan.attempt, stepSkill, effectiveRetry);
    const retryAdmission = admitRetryPolicy({
      stepId: step.id,
      retry: effectiveRetry,
      mutating: step.mutating || stepSkill.mutating === true,
      idempotencyKey: retryContext.idempotencyKey,
    });
    if (retryAdmission.status === "deny") {
      return {
        status: "policy_denied",
        graph,
        stepId: step.id,
        skill: stepSkill,
        reasons: retryAdmission.reasons,
        state,
      };
    }

    const stepStartedAt = new Date().toISOString();
    state = transitionSequentialGraph(state, {
      type: "start_step",
      stepId: step.id,
      at: stepStartedAt,
    });
    await reportGraphStepStarted(options.caller, step, resolvedStep.reference);
    await appendGraphStepStartedLedgerEntry({
      receiptDir,
      runId: graphId,
      topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
      step,
      reference: resolvedStep.reference,
      createdAt: stepStartedAt,
    });

    const stepResult = await runValidatedSkill({
      skill: stepSkill,
      skillDirectory: graphStepExecutionDirectory(step, stepSkillPath, graphDirectory),
      requestedSkillPath: resolvedStep.reference,
      inputs: stepInputs,
      caller: options.caller,
      env: options.env,
      receiptDir,
      runxHome: options.runxHome,
      knowledgeDir: options.knowledgeDir,
      parentReceipt: lastReceiptId,
      contextFrom: contextFromReceiptIds,
      adapters: options.adapters,
      allowedSourceTypes: options.allowedSourceTypes,
      authResolver: options.authResolver,
      receiptMetadata: mergeMetadata(
        inheritedReceiptMetadata,
        retryContext.receiptMetadata,
        governanceReceiptMetadata(step, governance),
      ),
      orchestrationRunId: graphId,
      orchestrationStepId: step.id,
      currentContext: context,
      registryStore: options.registryStore,
      skillCacheDir: options.skillCacheDir,
      toolCatalogAdapters: options.toolCatalogAdapters,
      context: contextSnapshot,
      voiceProfile,
      voiceProfilePath: options.voiceProfilePath,
      workspacePolicy,
    });

    if (stepResult.status === "needs_resolution") {
      await reportGraphStepWaitingResolution(
        options.caller,
        step,
        resolvedStep.reference,
        stepResult.requests,
      );
      await appendPendingGraphLedgerEntry({
        receiptDir,
        runId: graphId,
        topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
        stepId: step.id,
        kind: "step_waiting_resolution",
        detail: {
          request_ids: stepResult.requests.map((request) => request.id),
          resolution_kinds: Array.from(new Set(stepResult.requests.map((request) => request.kind))),
          requests: stepResult.requests,
          runner: graphStepRunner(step) ?? "default",
          step_label: step.label,
        },
        createdAt: new Date().toISOString(),
      });
      return {
        status: "needs_resolution",
        graph,
        stepIds: [step.id],
        stepLabels: [step.label ?? step.id],
        skillPath: stepSkillPath,
        skill: stepSkill,
        requests: stepResult.requests,
        state,
        runId: graphId,
      };
    }

    if (stepResult.status === "policy_denied") {
      await reportGraphStepCompleted(options.caller, step, resolvedStep.reference, "failure", {
        reason: `policy denied: ${stepResult.reasons.join("; ")}`,
      });
      await appendGraphStepFailureLedgerEntry({
        receiptDir,
        runId: graphId,
        topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
        stepId: step.id,
        reason: `policy denied: ${stepResult.reasons.join("; ")}`,
      });
      return {
        status: "policy_denied",
        graph,
        stepId: step.id,
        skill: stepResult.skill,
        reasons: stepResult.reasons,
        state: transitionSequentialGraph(state, {
          type: "step_failed",
          stepId: step.id,
          at: new Date().toISOString(),
          error: `policy denied: ${stepResult.reasons.join("; ")}`,
        }),
      };
    }

    const stepCompletedAt = new Date().toISOString();
    const artifactResult = materializeArtifacts({
      stdout: stepResult.execution.stdout,
      contract: stepResult.skill.artifacts,
      runId: graphId,
      stepId: step.id,
      producer: {
        skill: stepResult.skill.name,
        runner: stepResult.skill.source.type,
      },
      createdAt: stepCompletedAt,
    });
    const stepRun: GraphStepRun = {
      stepId: step.id,
      skill: resolvedStep.reference,
      skillPath: stepSkillPath,
      runner: graphStepRunner(step),
      attempt: plan.attempt,
      status: stepResult.status,
      receiptId: stepResult.receipt.id,
      stdout: stepResult.execution.stdout,
      stderr: stepResult.execution.stderr,
      parentReceipt: lastReceiptId,
      retry: retryContext.receipt,
      governance,
      artifactIds: artifactResult.envelopes.map((envelope) => envelope.meta.artifact_id),
      disposition: stepResult.receipt.disposition,
      inputContext: stepResult.receipt.input_context,
      outcomeState: stepResult.receipt.outcome_state,
      outcome: stepResult.receipt.outcome,
      surfaceRefs: stepResult.receipt.surface_refs,
      evidenceRefs: stepResult.receipt.evidence_refs,
      contextFrom: context.map((edge) => ({
        input: edge.input,
        fromStep: edge.fromStep,
        output: edge.output,
        receiptId: edge.receiptId,
      })),
    };
    stepRuns.push(stepRun);
    outputs.set(step.id, {
      status: stepResult.status,
      stdout: stepResult.execution.stdout,
      stderr: stepResult.execution.stderr,
      receiptId: stepResult.receipt.id,
      fields: artifactResult.fields,
      artifactIds: artifactResult.envelopes.map((envelope) => envelope.meta.artifact_id),
      artifacts: artifactResult.envelopes,
    });
    lastReceiptId = stepResult.receipt.id;
    finalOutput = stepResult.execution.stdout;
    await appendGraphLedgerEntries({
      receiptDir,
      runId: graphId,
      topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
      stepId: step.id,
      skill: stepResult.skill,
      artifactEnvelopes: artifactResult.envelopes,
      receiptId: stepResult.receipt.id,
      status: stepResult.status,
      detail: {
        runner: graphStepRunner(step) ?? "default",
      },
      createdAt: stepCompletedAt,
    });

    state =
      stepResult.status === "success"
        ? transitionSequentialGraph(state, {
            type: "step_succeeded",
            stepId: step.id,
            at: stepCompletedAt,
            receiptId: stepResult.receipt.id,
            outputs: artifactResult.fields,
          })
        : transitionSequentialGraph(state, {
            type: "step_failed",
            stepId: step.id,
            at: stepCompletedAt,
            error: stepResult.execution.errorMessage ?? stepResult.execution.stderr,
          });
    await reportGraphStepCompleted(options.caller, step, resolvedStep.reference, stepResult.status, {
      receiptId: stepResult.receipt.id,
    });
  }

  const completedAt = new Date().toISOString();
  const graphEscalated = state.status === "escalated";
  const receipt = await writeLocalGraphReceipt({
    receiptDir,
    runxHome: options.runxHome ?? options.env?.RUNX_HOME,
    graphId,
    graphName: graph.name,
    owner: graph.owner,
    status: state.status === "succeeded" ? "success" : "failure",
    inputs: options.inputs ?? {},
    output: finalOutput,
    steps: stepRuns.map(toGraphReceiptStep),
    syncPoints,
    startedAt,
    completedAt,
    durationMs: Date.now() - startedAtMs,
    errorMessage: finalError,
    disposition: graphEscalated ? "escalated" : executionSemantics.disposition,
    inputContext: executionSemantics.inputContext,
    outcomeState: graphEscalated ? "pending" : executionSemantics.outcomeState,
    outcome: executionSemantics.outcome,
    surfaceRefs: executionSemantics.surfaceRefs,
    evidenceRefs: executionSemantics.evidenceRefs,
    metadata: mergeMetadata(inheritedReceiptMetadata, terminalReceiptMetadata),
  });
  await appendGraphCompletedLedgerEntry({
    receiptDir,
    runId: graphId,
    topLevelSkillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
    receiptId: receipt.id,
    stepCount: stepRuns.length,
    status: receipt.status,
    createdAt: completedAt,
  });
  try {
    await indexReceiptIfEnabled(receipt, receiptDir, options);
  } catch (error) {
    await options.caller.report({
      type: "warning",
      message: "Local knowledge indexing failed after receipt write; continuing with the persisted receipt.",
      data: {
        receiptId: receipt.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
  await projectReflectIfEnabled({
    caller: options.caller,
    receipt,
    receiptDir,
    runId: graphId,
    skillName: graphProducerSkillName(options.skillEnvironment?.name, graph.name),
    knowledgeDir: options.knowledgeDir,
    env: options.env,
    selectedRunnerName: options.selectedRunnerName,
    postRunReflectPolicy: options.postRunReflectPolicy,
    involvedAgentMediatedWork,
  });

  return {
    status: graphEscalated ? "escalated" : receipt.status,
    graph,
    state,
    steps: stepRuns,
    receipt,
    output: finalOutput,
    errorMessage: finalError,
  };
}

function buildFanoutGateResolutionRequest(
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

function fanoutGateReceiptMetadata(
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

interface PendingFanoutGate {
  readonly gateKey: string;
  readonly groupId: string;
  readonly request: Extract<ResolutionRequest, { readonly kind: "approval" }>;
  readonly syncPoint: GraphReceiptSyncPoint;
  readonly stepIds: readonly string[];
  readonly stepLabels: readonly string[];
}

function readPendingFanoutGate(entries: readonly ArtifactEnvelope[]): PendingFanoutGate | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "run_event") {
      continue;
    }
    const kind = typeof entry.data.kind === "string" ? entry.data.kind : "";
    if (kind === "chain_completed" || kind === "run_completed" || kind === "run_failed") {
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

function firstFanoutStep(graph: ExecutionGraph, groupId: string): GraphStep | undefined {
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
