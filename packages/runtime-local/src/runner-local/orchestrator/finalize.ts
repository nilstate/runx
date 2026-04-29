import { writeLocalGraphReceipt } from "@runxhq/core/receipts";
import {
  appendPreparedLedgerEntries,
  createLedgerAnchorMetadata,
  inspectLedger,
  prepareLedgerAppend,
  type ArtifactEnvelope,
} from "@runxhq/core/artifacts";
import { errorMessage, isRecord } from "@runxhq/core/util";

import { buildGraphCompletedLedgerEntry } from "../graph-ledger.js";
import { graphProducerSkillName } from "../graph-reporting.js";
import { toGraphReceiptStep } from "../graph-governance.js";
import {
  indexReceiptIfEnabled,
  mergeMetadata,
} from "../runner-helpers.js";
import { projectReflectIfEnabled } from "../reflect.js";
import type { RunLocalGraphOptions, RunLocalGraphResult } from "../index.js";
import type { RunContext } from "./run-context.js";

export type FinalizeRunContext = Pick<
  RunContext,
  | "executionSemantics"
  | "finalError"
  | "finalOutput"
  | "graph"
  | "graphId"
  | "inheritedReceiptMetadata"
  | "involvedAgentMediatedWork"
  | "receiptDir"
  | "startedAt"
  | "startedAtMs"
  | "state"
  | "stepRuns"
  | "syncPoints"
  | "terminalReceiptMetadata"
>;

export async function finalizeRun(ctx: FinalizeRunContext, options: RunLocalGraphOptions): Promise<RunLocalGraphResult> {
  const completedAt = new Date().toISOString();
  const graphEscalated = ctx.state.status === "escalated";
  const terminalStatus = ctx.state.status === "succeeded" ? "success" : "failure";
  const topLevelSkillName = graphProducerSkillName(options.skillEnvironment?.name, ctx.graph.name);
  const completedLedgerEntry = buildGraphCompletedLedgerEntry({
    runId: ctx.graphId,
    topLevelSkillName,
    receiptId: ctx.graphId,
    stepCount: ctx.stepRuns.length,
    status: terminalStatus,
    createdAt: completedAt,
  });
  const existingLedger = await inspectLedger(ctx.receiptDir, ctx.graphId);
  const existingTerminalStatus = existingLedger.entries
    .map((entry) => graphCompletedLedgerStatus(entry, ctx.graphId))
    .find((status): status is "success" | "failure" => status !== undefined);
  if (existingTerminalStatus && existingTerminalStatus !== terminalStatus) {
    throw new Error(
      `Graph ${ctx.graphId} already has terminal ledger status ${existingTerminalStatus}; cannot finalize as ${terminalStatus}.`,
    );
  }
  const terminalAlreadyCommitted = existingTerminalStatus === terminalStatus;
  const ledgerPlan = await prepareLedgerAppend({
    receiptDir: ctx.receiptDir,
    runId: ctx.graphId,
    entries: terminalAlreadyCommitted ? [] : [completedLedgerEntry],
  });
  await appendPreparedLedgerEntries(ledgerPlan);
  const receipt = await writeLocalGraphReceipt({
    receiptDir: ctx.receiptDir,
    runxHome: options.runxHome ?? options.env?.RUNX_HOME,
    graphId: ctx.graphId,
    graphName: ctx.graph.name,
    owner: ctx.graph.owner,
    status: terminalStatus,
    inputs: options.inputs ?? {},
    output: ctx.finalOutput,
    steps: ctx.stepRuns.map(toGraphReceiptStep),
    syncPoints: ctx.syncPoints,
    startedAt: ctx.startedAt,
    completedAt,
    durationMs: Date.now() - ctx.startedAtMs,
    errorMessage: ctx.finalError,
    disposition: graphEscalated ? "escalated" : ctx.executionSemantics.disposition,
    inputContext: ctx.executionSemantics.inputContext,
    outcomeState: graphEscalated ? "pending" : ctx.executionSemantics.outcomeState,
    outcome: ctx.executionSemantics.outcome,
    surfaceRefs: ctx.executionSemantics.surfaceRefs,
    evidenceRefs: ctx.executionSemantics.evidenceRefs,
    metadata: mergeMetadata(
      ctx.inheritedReceiptMetadata,
      ctx.terminalReceiptMetadata,
      createLedgerAnchorMetadata(ledgerPlan.anchor),
    ),
  });
  try {
    await indexReceiptIfEnabled(receipt, ctx.receiptDir, options);
  } catch (error) {
    await options.caller.report({
      type: "warning",
      message: "Local knowledge indexing failed after receipt write; continuing with the persisted receipt.",
      data: {
        receiptId: receipt.id,
        error: errorMessage(error),
      },
    });
  }
  await projectReflectIfEnabled({
    caller: options.caller,
    receipt,
    receiptDir: ctx.receiptDir,
    runId: ctx.graphId,
    skillName: topLevelSkillName,
    knowledgeDir: options.knowledgeDir,
    env: options.env,
    selectedRunnerName: options.selectedRunnerName,
    postRunReflectPolicy: options.postRunReflectPolicy,
    involvedAgentMediatedWork: ctx.involvedAgentMediatedWork,
  });

  return {
    status: graphEscalated ? "escalated" : receipt.status,
    graph: ctx.graph,
    state: ctx.state,
    steps: [...ctx.stepRuns],
    receipt,
    output: ctx.finalOutput,
    errorMessage: ctx.finalError,
  };
}

function graphCompletedLedgerStatus(
  entry: ArtifactEnvelope,
  graphId: string,
): "success" | "failure" | undefined {
  if (entry.type !== "run_event" || entry.meta.run_id !== graphId || entry.meta.step_id !== null) {
    return undefined;
  }
  const detail = isRecord(entry.data.detail) ? entry.data.detail : undefined;
  if (entry.data.kind !== "graph_completed" || detail?.receipt_id !== graphId) {
    return undefined;
  }
  return entry.data.status === "success" || entry.data.status === "failure"
    ? entry.data.status
    : undefined;
}
