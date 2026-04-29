import { removeLocalReceipt, writeLocalGraphReceipt } from "@runxhq/core/receipts";
import {
  appendPreparedLedgerEntries,
  createLedgerAnchorMetadata,
  prepareLedgerAppend,
} from "@runxhq/core/artifacts";
import { errorMessage } from "@runxhq/core/util";

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

export async function finalizeRun(ctx: RunContext, options: RunLocalGraphOptions): Promise<RunLocalGraphResult> {
  const completedAt = new Date().toISOString();
  const graphEscalated = ctx.state.status === "escalated";
  const topLevelSkillName = graphProducerSkillName(options.skillEnvironment?.name, ctx.graph.name);
  const completedLedgerEntry = buildGraphCompletedLedgerEntry({
    runId: ctx.graphId,
    topLevelSkillName,
    receiptId: ctx.graphId,
    stepCount: ctx.stepRuns.length,
    status: ctx.state.status === "succeeded" ? "success" : "failure",
    createdAt: completedAt,
  });
  const ledgerPlan = await prepareLedgerAppend({
    receiptDir: ctx.receiptDir,
    runId: ctx.graphId,
    entries: [completedLedgerEntry],
  });
  const receipt = await writeLocalGraphReceipt({
    receiptDir: ctx.receiptDir,
    runxHome: options.runxHome ?? options.env?.RUNX_HOME,
    graphId: ctx.graphId,
    graphName: ctx.graph.name,
    owner: ctx.graph.owner,
    status: ctx.state.status === "succeeded" ? "success" : "failure",
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
    await appendPreparedLedgerEntries(ledgerPlan);
  } catch (error) {
    await removeLocalReceipt(ctx.receiptDir, receipt.id);
    throw error;
  }
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
