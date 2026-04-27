import { loadRunxWorkspacePolicy } from "@runxhq/core/config";
import { uniqueReceiptId } from "@runxhq/core/receipts";
import { createSequentialGraphState } from "@runxhq/core/state-machine";

import {
  contextReceiptMetadata,
  loadContext,
  loadVoiceProfile,
  voiceProfileReceiptMetadata,
} from "../context.js";
import { defaultReceiptDir } from "../receipt-paths.js";
import {
  loadGraphStepExecutables,
  resolveGraphExecution,
} from "../execution-targets.js";
import { normalizeExecutionSemantics } from "../execution-semantics.js";
import {
  defaultLocalGraphGrant,
  mergeMetadata,
  unique,
} from "../runner-helpers.js";
import { type GraphStepOutput } from "../graph-context.js";
import type { GraphStepRun, RunLocalGraphOptions } from "../index.js";

import type { RunContext } from "./run-context.js";

export async function prepareRun(options: RunLocalGraphOptions): Promise<RunContext> {
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
    options.officialSkillResolver,
  );
  const graphGrant = options.graphGrant ?? defaultLocalGraphGrant();
  const graphSteps = graph.steps.map((step) => ({
    id: step.id,
    contextFrom: unique(step.contextEdges.map((edge) => edge.fromStep)),
    retry: step.retry ?? graphStepCache.get(step.id)?.retry,
    fanoutGroup: step.fanoutGroup,
  }));
  const state = createSequentialGraphState(graphId, graphSteps);

  return {
    options,
    graphResolution,
    graph,
    graphDirectory,
    graphSteps,
    graphStepCache,
    graphGrant,
    graphId,
    receiptDir,
    contextSnapshot,
    voiceProfile,
    executionSemantics,
    workspacePolicy,
    inheritedReceiptMetadata,
    startedAt,
    startedAtMs,
    state,
    stepRuns: [] as GraphStepRun[],
    syncPoints: [],
    resolvedFanoutGateKeys: new Set<string>(),
    outputs: new Map<string, GraphStepOutput>(),
    lastReceiptId: undefined,
    finalOutput: "",
    finalError: undefined,
    terminalReceiptMetadata: undefined,
    graphAlreadyTerminal: false,
    involvedAgentMediatedWork: false,
  };
}
