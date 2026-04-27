import { readLedgerEntries } from "@runxhq/core/artifacts";
import { transitionSequentialGraph, type SequentialGraphState } from "@runxhq/core/state-machine";

import { resolveGraphStepExecution } from "../execution-targets.js";
import {
  firstFanoutStep,
  readPendingFanoutGate,
} from "../graph-fanout-gates.js";
import { hydrateGraphFromLedger } from "../graph-hydration.js";
import { isAgentMediatedSource } from "../runner-helpers.js";
import type { RunLocalGraphOptions, RunLocalGraphResult } from "../index.js";

import type { RunContext } from "./run-context.js";

export async function hydrateResumedRun(
  ctx: RunContext,
  options: RunLocalGraphOptions,
): Promise<RunLocalGraphResult | undefined> {
  if (!options.resumeFromRunId) {
    return undefined;
  }

  const resumeEntries = await readLedgerEntries(ctx.receiptDir, options.resumeFromRunId);
  hydrateGraphFromLedger({
    entries: resumeEntries,
    graph: ctx.graph,
    graphStepCache: ctx.graphStepCache,
    skillEnvironment: options.skillEnvironment,
    graphSteps: ctx.graphSteps,
    stepRuns: ctx.stepRuns,
    outputs: ctx.outputs,
    syncPoints: ctx.syncPoints,
    stateRef: {
      get value() {
        return ctx.state;
      },
      set value(next: SequentialGraphState) {
        ctx.state = next;
      },
    },
    lastReceiptRef: {
      get value() {
        return ctx.lastReceiptId;
      },
      set value(next: string | undefined) {
        ctx.lastReceiptId = next;
      },
    },
  });

  const pendingFanoutGate = readPendingFanoutGate(resumeEntries);
  if (pendingFanoutGate) {
    ctx.syncPoints.push(pendingFanoutGate.syncPoint);
    const resolution = await options.caller.resolve(pendingFanoutGate.request);
    if (resolution === undefined) {
      const pendingStep = firstFanoutStep(ctx.graph, pendingFanoutGate.groupId);
      if (!pendingStep) {
        throw new Error(`Unable to resume fanout gate for unknown group '${pendingFanoutGate.groupId}'.`);
      }
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
      return {
        status: "needs_resolution",
        graph: ctx.graph,
        stepIds: pendingFanoutGate.stepIds,
        stepLabels: pendingFanoutGate.stepLabels,
        skillPath: resolvedStep.skillPath,
        skill: resolvedStep.skill,
        requests: [pendingFanoutGate.request],
        state: ctx.state,
        runId: ctx.graphId,
      };
    }
    const approved = typeof resolution.payload === "boolean" ? resolution.payload : Boolean(resolution.payload);
    if (approved) {
      ctx.resolvedFanoutGateKeys.add(pendingFanoutGate.gateKey);
    } else {
      ctx.finalError = `fanout gate denied: ${pendingFanoutGate.syncPoint.reason}`;
      ctx.state = transitionSequentialGraph(ctx.state, { type: "fail_graph", error: ctx.finalError });
      ctx.graphAlreadyTerminal = true;
    }
  }

  ctx.involvedAgentMediatedWork = ctx.stepRuns.some((stepRun) => {
    const step = ctx.graph.steps.find((candidate) => candidate.id === stepRun.stepId);
    const cachedSkill = ctx.graphStepCache.get(stepRun.stepId);
    if (cachedSkill) {
      return isAgentMediatedSource(cachedSkill.source.type);
    }
    return isAgentMediatedSource(String(step?.run?.type ?? ""));
  });

  return undefined;
}
