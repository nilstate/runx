import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  inspectLedger,
  parseLedgerAnchorMetadata,
  type ArtifactEnvelope,
  type LedgerVerification,
  SYSTEM_ARTIFACT_TYPES,
  readLedgerEntries,
} from "@runxhq/core/artifacts";
import {
  listVerifiedLocalReceipts,
  readVerifiedLocalReceipt,
  type LocalGraphReceipt,
  type LocalReceipt,
  type ReceiptVerification,
} from "@runxhq/core/receipts";
import { errorMessage, isNotFound, isRecord } from "@runxhq/core/util";
import { defaultReceiptDir } from "./receipt-paths.js";
import { readPendingRunState, type PendingRunState } from "./inputs.js";

export interface InspectLocalGraphOptions {
  readonly graphId: string;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface InspectLocalReceiptOptions {
  readonly receiptId: string;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface InspectLocalReceiptResult {
  readonly receipt: LocalReceipt;
  readonly verification: ReceiptVerification;
  readonly ledgerVerification: LedgerVerification;
  readonly summary: LocalReceiptSummary;
}

export type InspectLocalRunStateResult =
  | {
      readonly status: "paused";
      readonly runId: string;
      readonly pending: PendingRunState;
    }
  | {
      readonly status: "terminal";
      readonly runId: string;
      readonly receipt: LocalReceipt;
      readonly verification: ReceiptVerification;
      readonly ledgerVerification: LedgerVerification;
      readonly summary: LocalReceiptSummary;
    };

export interface ListLocalHistoryOptions {
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly limit?: number;
  readonly query?: string;
  readonly skill?: string;
  readonly status?: string;
  readonly sourceType?: string;
  readonly actor?: string;
  readonly artifactType?: string;
  readonly sinceMs?: number;
  readonly untilMs?: number;
}

export interface ListLocalHistoryResult {
  readonly receipts: readonly LocalReceiptSummary[];
  readonly pendingRuns: readonly PausedRunSummary[];
}

export interface RunLineageSummary {
  readonly kind: "rerun";
  readonly sourceRunId: string;
  readonly sourceReceiptId?: string;
}

export interface RunApprovalSummary {
  readonly gateId?: string;
  readonly gateType?: string;
  readonly decision?: "approved" | "denied";
  readonly reason?: string;
}

export interface ComparableRunSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly sourceType?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly actors?: readonly string[];
  readonly artifactTypes?: readonly string[];
  readonly disposition?: string;
  readonly outcomeState?: string;
  readonly runnerProvider?: string;
  readonly approval?: RunApprovalSummary;
  readonly lineage?: RunLineageSummary;
  readonly error?: string;
  readonly ledgerVerification?: LedgerVerification;
}

export interface LocalReceiptSummary extends ComparableRunSummary {
  readonly kind: LocalReceipt["kind"];
  readonly status: LocalReceipt["status"];
  readonly verification: ReceiptVerification;
  readonly ledgerVerification: LedgerVerification;
}

export interface PausedRunSummary extends ComparableRunSummary {
  readonly kind: LocalReceipt["kind"];
  readonly status: "paused";
  readonly selectedRunner?: string;
  readonly stepIds: readonly string[];
  readonly stepLabels: readonly string[];
  readonly ledgerVerification?: LedgerVerification;
}

export interface InspectLocalRunOptions {
  readonly referenceId: string;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type InspectLocalRunResult =
  | {
      readonly kind: "terminal";
      readonly receipt: LocalReceipt;
      readonly verification: ReceiptVerification;
      readonly ledgerVerification: LedgerVerification;
      readonly summary: LocalReceiptSummary;
    }
  | {
      readonly kind: "paused";
      readonly runId: string;
      readonly pending: PendingRunState;
      readonly summary: PausedRunSummary;
    };

export interface RunSummaryFieldDelta {
  readonly left?: unknown;
  readonly right?: unknown;
}

export interface RunSummaryCollectionDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface RunSummaryDiff {
  readonly left: ComparableRunSummary;
  readonly right: ComparableRunSummary;
  readonly changed: boolean;
  readonly fields: Readonly<Record<string, RunSummaryFieldDelta>>;
  readonly actors: RunSummaryCollectionDelta;
  readonly artifactTypes: RunSummaryCollectionDelta;
}

export interface ReadLocalReplaySeedOptions {
  readonly referenceId: string;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface LocalReplaySeed {
  readonly runId: string;
  readonly receiptId: string;
  readonly receipt: LocalReceipt;
  readonly verification: ReceiptVerification;
  readonly skillPath: string;
  readonly selectedRunner?: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly lineage: RunLineageSummary;
}

export interface DiffLocalRunsOptions {
  readonly left: string;
  readonly right: string;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface InspectLocalGraphResult {
  readonly receipt: LocalGraphReceipt;
  readonly verification: ReceiptVerification;
  readonly summary: {
    readonly id: string;
    readonly name: string;
    readonly status: "success" | "failure";
    readonly verification: ReceiptVerification;
    readonly steps: readonly {
      readonly id: string;
      readonly attempt: number;
      readonly status: "success" | "failure";
      readonly receiptId?: string;
      readonly fanoutGroup?: string;
    }[];
    readonly syncPoints: readonly {
      readonly groupId: string;
      readonly decision: "proceed" | "halt" | "pause" | "escalate";
      readonly ruleFired: string;
      readonly reason: string;
    }[];
  };
}

export async function inspectLocalGraph(options: InspectLocalGraphOptions): Promise<InspectLocalGraphResult> {
  const { receipt, verification } = await readVerifiedLocalReceipt(
    options.receiptDir ?? defaultReceiptDir(options.env),
    options.graphId,
    options.runxHome ?? options.env?.RUNX_HOME,
  );
  if (receipt.kind !== "graph_execution") {
    throw new Error(`Receipt ${options.graphId} is not a graph execution receipt.`);
  }

  return {
    receipt,
    verification,
    summary: {
      id: receipt.id,
      name: receipt.graph_name,
      status: receipt.status,
      verification,
      steps: receipt.steps.map((step) => ({
        id: step.step_id,
        attempt: step.attempt,
        status: step.status,
        receiptId: step.receipt_id,
        fanoutGroup: step.fanout_group,
      })),
      syncPoints: (receipt.sync_points ?? []).map((syncPoint) => ({
        groupId: syncPoint.group_id,
        decision: syncPoint.decision,
        ruleFired: syncPoint.rule_fired,
        reason: syncPoint.reason,
      })),
    },
  };
}

export async function inspectLocalReceipt(options: InspectLocalReceiptOptions): Promise<InspectLocalReceiptResult> {
  const receiptDir = options.receiptDir ?? defaultReceiptDir(options.env);
  const { receipt, verification } = await readVerifiedLocalReceipt(
    receiptDir,
    options.receiptId,
    options.runxHome ?? options.env?.RUNX_HOME,
  );
  const summary = await summarizeLocalReceipt(receipt, verification, receiptDir);
  return {
    receipt,
    verification,
    ledgerVerification: summary.ledgerVerification,
    summary,
  };
}

export async function inspectLocalRunState(options: {
  readonly referenceId: string;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<InspectLocalRunStateResult> {
  const receiptDir = options.receiptDir ?? defaultReceiptDir(options.env);
  const pending = await tryReadPendingRunState(receiptDir, options.referenceId);
  if (pending) {
    return {
      status: "paused",
      runId: options.referenceId,
      pending,
    };
  }

  const resolved = await resolveLocalRunReference(options.referenceId, receiptDir, options.runxHome ?? options.env?.RUNX_HOME);
  const summary = await summarizeLocalReceipt(
    resolved.receipt,
    resolved.verification,
    receiptDir,
    resolved.ledgerEntries,
    resolved.runId,
  );
  return {
    status: "terminal",
    runId: resolved.runId,
    receipt: resolved.receipt,
    verification: resolved.verification,
    ledgerVerification: summary.ledgerVerification,
    summary,
  };
}

export async function listLocalHistory(options: ListLocalHistoryOptions = {}): Promise<ListLocalHistoryResult> {
  const receiptDir = options.receiptDir ?? defaultReceiptDir(options.env);
  const receipts = await listVerifiedLocalReceipts(
    receiptDir,
    options.runxHome ?? options.env?.RUNX_HOME,
  );
  const normalizedQuery = options.query?.trim().toLowerCase();
  const skillFilter = options.skill?.trim().toLowerCase();
  const statusFilter = options.status?.trim().toLowerCase();
  const sourceFilter = options.sourceType?.trim().toLowerCase();
  const actorFilter = options.actor?.trim().toLowerCase();
  const artifactTypeFilter = options.artifactType?.trim().toLowerCase();
  const sinceMs = options.sinceMs;
  const untilMs = options.untilMs;
  const summaries = await Promise.all(
    receipts.map(async ({ receipt, verification }) => await summarizeLocalReceipt(receipt, verification, receiptDir)),
  );
  const terminalIds = new Set(summaries.map((summary) => summary.id));
  const pendingSummaries = await listPendingRunSummaries(receiptDir, terminalIds);

  const matchesFilters = (summary: ComparableRunSummary): boolean => {
    if (normalizedQuery) {
      const normalizedActors = (summary.actors ?? []).map((entry) => entry.toLowerCase());
      const normalizedArtifactTypes = (summary.artifactTypes ?? []).map((entry) => entry.toLowerCase());
      const matchesQuery =
        summary.name.toLowerCase().includes(normalizedQuery) ||
        summary.id.toLowerCase().includes(normalizedQuery) ||
        (summary.sourceType?.toLowerCase().includes(normalizedQuery) ?? false) ||
        normalizedActors.some((entry) => entry.includes(normalizedQuery)) ||
        normalizedArtifactTypes.some((entry) => entry.includes(normalizedQuery));
      if (!matchesQuery) return false;
    }
    if (skillFilter && !summary.name.toLowerCase().includes(skillFilter)) {
      return false;
    }
    if (statusFilter && String(summary.status ?? "").toLowerCase() !== statusFilter) {
      return false;
    }
    if (sourceFilter && (summary.sourceType ?? "").toLowerCase() !== sourceFilter) {
      return false;
    }
    if (actorFilter) {
      const normalizedActors = (summary.actors ?? []).map((entry) => entry.toLowerCase());
      if (!normalizedActors.includes(actorFilter)) {
        return false;
      }
    }
    if (artifactTypeFilter) {
      const normalizedArtifactTypes = (summary.artifactTypes ?? []).map((entry) => entry.toLowerCase());
      if (!normalizedArtifactTypes.includes(artifactTypeFilter)) {
        return false;
      }
    }
    if (sinceMs !== undefined) {
      const startedMs = summary.startedAt ? Date.parse(summary.startedAt) : NaN;
      if (!Number.isFinite(startedMs) || startedMs < sinceMs) return false;
    }
    if (untilMs !== undefined) {
      const startedMs = summary.startedAt ? Date.parse(summary.startedAt) : NaN;
      if (!Number.isFinite(startedMs) || startedMs > untilMs) return false;
    }
    return true;
  };

  return {
    receipts: summaries.filter(matchesFilters).slice(0, options.limit ?? receipts.length),
    pendingRuns: pendingSummaries.filter(matchesFilters),
  };
}

async function listPendingRunSummaries(
  receiptDir: string,
  terminalIds: ReadonlySet<string>,
): Promise<readonly PausedRunSummary[]> {
  const ledgersDir = path.join(receiptDir, "ledgers");
  let entries: readonly string[];
  try {
    entries = await readdir(ledgersDir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const candidates = entries
    .filter((entry) => /^(rx|gx)_[A-Za-z0-9_-]+\.jsonl$/.test(entry))
    .map((entry) => entry.slice(0, -".jsonl".length))
    .filter((id) => !terminalIds.has(id));

  const summaries: PausedRunSummary[] = [];
  for (const id of candidates) {
    const ledgerVerification = (await inspectLedger(receiptDir, id)).verification;
    if (ledgerVerification.status === "invalid") {
      summaries.push({
        id,
        name: id,
        kind: id.startsWith("gx_") ? "graph_execution" : "skill_execution",
        status: "paused",
        stepIds: [],
        stepLabels: [],
        ledgerVerification,
      });
      continue;
    }
    const pending = await readPendingRunState(receiptDir, id);
    if (!pending) continue;
    summaries.push(buildPausedRunSummary(id, pending, ledgerVerification));
  }
  return summaries;
}

async function tryReadPendingRunState(receiptDir: string, runId: string): Promise<PendingRunState | undefined> {
  try {
    return await readPendingRunState(receiptDir, runId);
  } catch (error) {
    if (errorMessage(error).includes("failed verification")) {
      return undefined;
    }
    throw error;
  }
}

function buildPausedRunSummary(
  runId: string,
  pending: PendingRunState,
  ledgerVerification?: LedgerVerification,
): PausedRunSummary {
  return {
    id: runId,
    name: pending.skillName && pending.skillName.trim().length > 0 ? pending.skillName : runId,
    kind: runId.startsWith("gx_") ? "graph_execution" : "skill_execution",
    status: "paused",
    selectedRunner: pending.selectedRunner,
    stepIds: pending.stepIds,
    stepLabels: pending.stepLabels,
    ledgerVerification,
  };
}

export async function inspectLocalRun(options: InspectLocalRunOptions): Promise<InspectLocalRunResult> {
  const receiptDir = options.receiptDir ?? defaultReceiptDir(options.env);
  const runxHome = options.runxHome ?? options.env?.RUNX_HOME;
  try {
    const { receipt, verification } = await readVerifiedLocalReceipt(receiptDir, options.referenceId, runxHome);
    const summary = await summarizeLocalReceipt(receipt, verification, receiptDir);
    return {
      kind: "terminal",
      receipt,
      verification,
      ledgerVerification: summary.ledgerVerification,
      summary,
    };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const ledgerVerification = (await inspectLedger(receiptDir, options.referenceId)).verification;
    if (ledgerVerification.status === "invalid") {
      return {
        kind: "paused",
        runId: options.referenceId,
        pending: {
          inputs: {},
          requestIds: [],
          resolutionKinds: [],
          stepIds: [],
          stepLabels: [],
        },
        summary: {
          id: options.referenceId,
          name: options.referenceId,
          kind: options.referenceId.startsWith("gx_") ? "graph_execution" : "skill_execution",
          status: "paused",
          stepIds: [],
          stepLabels: [],
          ledgerVerification,
        },
      };
    }
    const pending = await readPendingRunState(receiptDir, options.referenceId);
    if (!pending) throw error;
    return {
      kind: "paused",
      runId: options.referenceId,
      pending,
      summary: buildPausedRunSummary(options.referenceId, pending, ledgerVerification),
    };
  }
}

export async function readLocalReplaySeed(options: ReadLocalReplaySeedOptions): Promise<LocalReplaySeed> {
  const receiptDir = options.receiptDir ?? defaultReceiptDir(options.env);
  const pending = await readPendingRunState(receiptDir, options.referenceId);
  if (pending) {
    throw new Error(`Run '${options.referenceId}' is paused. Use 'runx resume ${options.referenceId}' instead of replay.`);
  }

  const resolved = await resolveLocalRunReference(options.referenceId, receiptDir, options.runxHome ?? options.env?.RUNX_HOME);
  const seed = extractReplaySeed(resolved.ledgerEntries);
  if (!seed?.skillPath || !seed.inputs) {
    throw new Error(
      `Run '${options.referenceId}' is missing replay seed details. Replay requires a local ledger with recorded skill_path and inputs.`,
    );
  }
  return {
    runId: resolved.runId,
    receiptId: resolved.receipt.id,
    receipt: resolved.receipt,
    verification: resolved.verification,
    skillPath: seed.skillPath,
    selectedRunner: seed.selectedRunner,
    inputs: seed.inputs,
    lineage: {
      kind: "rerun",
      sourceRunId: resolved.runId,
      sourceReceiptId: resolved.receipt.id,
    },
  };
}

export async function diffLocalRuns(options: DiffLocalRunsOptions): Promise<RunSummaryDiff> {
  const receiptDir = options.receiptDir ?? defaultReceiptDir(options.env);
  const runxHome = options.runxHome ?? options.env?.RUNX_HOME;
  const [left, right] = await Promise.all([
    resolveLocalRunReference(options.left, receiptDir, runxHome),
    resolveLocalRunReference(options.right, receiptDir, runxHome),
  ]);
  return diffRunSummaries(
    await summarizeLocalReceipt(left.receipt, left.verification, receiptDir, left.ledgerEntries, left.runId),
    await summarizeLocalReceipt(right.receipt, right.verification, receiptDir, right.ledgerEntries, right.runId),
  );
}

export function diffRunSummaries(left: ComparableRunSummary, right: ComparableRunSummary): RunSummaryDiff {
  const fields = compactFieldDiff({
    status: diffScalar(left.status, right.status),
    kind: diffScalar(left.kind, right.kind),
    name: diffScalar(left.name, right.name),
    source_type: diffScalar(left.sourceType, right.sourceType),
    disposition: diffScalar(left.disposition, right.disposition),
    outcome_state: diffScalar(left.outcomeState, right.outcomeState),
    runner_provider: diffScalar(left.runnerProvider, right.runnerProvider),
    approval: diffScalar(left.approval, right.approval),
    lineage: diffScalar(left.lineage, right.lineage),
    error: diffScalar(left.error, right.error),
  });
  const actors = diffStringCollections(left.actors, right.actors);
  const artifactTypes = diffStringCollections(left.artifactTypes, right.artifactTypes);
  return {
    left,
    right,
    changed: Object.keys(fields).length > 0 || actors.added.length > 0 || actors.removed.length > 0 || artifactTypes.added.length > 0 || artifactTypes.removed.length > 0,
    fields,
    actors,
    artifactTypes,
  };
}

async function summarizeLocalReceipt(
  receipt: LocalReceipt,
  verification: ReceiptVerification,
  receiptDir: string,
  preloadedLedgerEntries?: readonly ArtifactEnvelope[],
  ledgerRunId = receipt.id,
): Promise<LocalReceiptSummary> {
  const ledgerInspection = await inspectLedger(
    receiptDir,
    ledgerRunId,
    parseLedgerAnchorMetadata(receipt.metadata),
  );
  const ledgerEntries = ledgerInspection.verification.status === "invalid"
    ? (preloadedLedgerEntries ?? [])
    : ledgerInspection.entries;
  const actors = extractReceiptActors(receipt);
  const artifactTypes = extractReceiptArtifactTypes(receipt, ledgerEntries);
  const metadata = isRecord(receipt.metadata) ? receipt.metadata : undefined;
  const approval = extractReceiptApproval(receipt);
  const lineage = extractReceiptLineage(receipt);
  const runnerProvider = metadata ? readNestedString(metadata, ["runner", "provider"]) : undefined;
  if (receipt.kind === "skill_execution") {
    return {
      id: receipt.id,
      kind: receipt.kind,
      status: receipt.status,
      verification,
      name: resolveSummaryName(receipt.skill_name, receipt.id),
      sourceType: receipt.source_type,
      startedAt: receipt.started_at,
      completedAt: receipt.completed_at,
      actors,
      artifactTypes,
      disposition: receipt.disposition,
      outcomeState: receipt.outcome_state,
      approval,
      lineage,
      runnerProvider,
      ledgerVerification: ledgerInspection.verification,
    };
  }

  return {
    id: receipt.id,
    kind: receipt.kind,
    status: receipt.status,
    verification,
    name: resolveSummaryName(receipt.graph_name, receipt.id),
    startedAt: receipt.started_at,
    completedAt: receipt.completed_at,
    actors,
    artifactTypes,
    disposition: receipt.disposition,
    outcomeState: receipt.outcome_state,
    approval,
    lineage,
    runnerProvider,
    ledgerVerification: ledgerInspection.verification,
  };
}

function resolveSummaryName(field: string | null | undefined, fallbackId: string): string {
  if (typeof field === "string" && field.trim().length > 0) {
    return field;
  }
  return fallbackId;
}

function extractReceiptActors(receipt: LocalReceipt): readonly string[] | undefined {
  const metadata = isRecord(receipt.metadata) ? receipt.metadata : undefined;
  if (!metadata) {
    return undefined;
  }
  const actors = [
    readNestedString(metadata, ["agent_hook", "agent"]),
    readNestedString(metadata, ["agent_runner", "skill"]),
    readNestedString(metadata, ["auth", "provider"]),
    readNestedString(metadata, ["runner", "provider"]),
    readNestedString(metadata, ["approval", "gate_type"]),
  ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return actors.length > 0 ? Array.from(new Set(actors)) : undefined;
}

function extractReceiptArtifactTypes(
  receipt: LocalReceipt,
  ledgerEntries: readonly ArtifactEnvelope[],
): readonly string[] | undefined {
  const directArtifactIds = receipt.kind === "skill_execution" && Array.isArray(receipt.artifact_ids)
    ? new Set(receipt.artifact_ids)
    : undefined;
  const artifactTypes = ledgerEntries
    .filter((entry) => entry.type !== null && !SYSTEM_ARTIFACT_TYPES.has(entry.type))
    .filter((entry) => !directArtifactIds || directArtifactIds.has(entry.meta.artifact_id))
    .map((entry) => entry.type as string);
  return artifactTypes.length > 0 ? Array.from(new Set(artifactTypes)) : undefined;
}

function extractReceiptApproval(receipt: LocalReceipt): RunApprovalSummary | undefined {
  const metadata = isRecord(receipt.metadata) ? receipt.metadata : undefined;
  if (!metadata) {
    return undefined;
  }
  const approval = metadata.approval;
  if (!isRecord(approval)) {
    return undefined;
  }
  const decision = approval.decision === "approved" || approval.decision === "denied"
    ? approval.decision
    : undefined;
  return {
    gateId: typeof approval.gate_id === "string" ? approval.gate_id : undefined,
    gateType: typeof approval.gate_type === "string" ? approval.gate_type : undefined,
    decision,
    reason: typeof approval.reason === "string" ? approval.reason : undefined,
  };
}

function extractReceiptLineage(receipt: LocalReceipt): RunLineageSummary | undefined {
  const metadata = isRecord(receipt.metadata) ? receipt.metadata : undefined;
  if (!metadata) {
    return undefined;
  }
  const runx = metadata.runx;
  if (!isRecord(runx) || !isRecord(runx.lineage)) {
    return undefined;
  }
  const sourceRunId = typeof runx.lineage.source_run_id === "string" ? runx.lineage.source_run_id : undefined;
  if (!sourceRunId) {
    return undefined;
  }
  return {
    kind: "rerun",
    sourceRunId,
    sourceReceiptId: typeof runx.lineage.source_receipt_id === "string" ? runx.lineage.source_receipt_id : undefined,
  };
}

async function resolveLocalRunReference(
  referenceId: string,
  receiptDir: string,
  runxHome: string | undefined,
): Promise<{
  readonly runId: string;
  readonly receipt: LocalReceipt;
  readonly verification: ReceiptVerification;
  readonly ledgerEntries: readonly ArtifactEnvelope[];
}> {
  const direct = await tryReadLocalReceipt(referenceId, receiptDir, runxHome);
  if (direct) {
    return {
      runId: referenceId,
      receipt: direct.receipt,
      verification: direct.verification,
      ledgerEntries: await readLedgerEntries(receiptDir, referenceId),
    };
  }

  const receiptId = await findReceiptIdForRunId(receiptDir, referenceId);
  if (!receiptId) {
    throw new Error(`Run or receipt '${referenceId}' was not found.`);
  }
  const resolved = await readVerifiedLocalReceipt(receiptDir, receiptId, runxHome);
  return {
    runId: referenceId,
    receipt: resolved.receipt,
    verification: resolved.verification,
    ledgerEntries: await readLedgerEntries(receiptDir, referenceId),
  };
}

async function tryReadLocalReceipt(
  receiptId: string,
  receiptDir: string,
  runxHome: string | undefined,
): Promise<{ readonly receipt: LocalReceipt; readonly verification: ReceiptVerification } | undefined> {
  try {
    return await readVerifiedLocalReceipt(receiptDir, receiptId, runxHome);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

async function findReceiptIdForRunId(receiptDir: string, runId: string): Promise<string | undefined> {
  const ledgerEntries = (await inspectLedger(receiptDir, runId)).entries;
  for (let index = ledgerEntries.length - 1; index >= 0; index -= 1) {
    const entry = ledgerEntries[index]!;
    if (entry.type !== "run_event") {
      continue;
    }
    const kind = typeof entry.data.kind === "string" ? entry.data.kind : "";
    const detail = isRecord(entry.data.detail) ? entry.data.detail : undefined;
    if (isTerminalRunEventKind(kind) && detail && typeof detail.receipt_id === "string") {
      return detail.receipt_id;
    }
  }
  return undefined;
}

function isTerminalRunEventKind(kind: string): boolean {
  return kind === "run_completed" || kind === "run_failed" || kind === "graph_completed";
}

function extractReplaySeed(entries: readonly ArtifactEnvelope[]): {
  readonly skillPath?: string;
  readonly selectedRunner?: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
} | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "run_event") {
      continue;
    }
    const kind = typeof entry.data.kind === "string" ? entry.data.kind : "";
    if (kind !== "resolution_requested" && kind !== "run_started" && kind !== "step_waiting_resolution") {
      continue;
    }
    const detail = isRecord(entry.data.detail) ? entry.data.detail : undefined;
    if (!detail) {
      continue;
    }
    const inputs = isRecord(detail.inputs) ? detail.inputs : undefined;
    const skillPath = typeof detail.skill_path === "string" ? detail.skill_path : undefined;
    const selectedRunner = typeof detail.selected_runner === "string" ? detail.selected_runner : undefined;
    if (skillPath || inputs) {
      return { skillPath, selectedRunner, inputs };
    }
  }
  return undefined;
}

function diffScalar(left: unknown, right: unknown): RunSummaryFieldDelta | undefined {
  if (stableDiffValue(left) === stableDiffValue(right)) {
    return undefined;
  }
  return { left, right };
}

function diffStringCollections(left: readonly string[] | undefined, right: readonly string[] | undefined): RunSummaryCollectionDelta {
  const leftSet = new Set(left ?? []);
  const rightSet = new Set(right ?? []);
  return {
    added: Array.from(rightSet).filter((entry) => !leftSet.has(entry)),
    removed: Array.from(leftSet).filter((entry) => !rightSet.has(entry)),
  };
}

function compactFieldDiff(
  fields: Readonly<Record<string, RunSummaryFieldDelta | undefined>>,
): Readonly<Record<string, RunSummaryFieldDelta>> {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, RunSummaryFieldDelta] => entry[1] !== undefined),
  );
}

function stableDiffValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function readNestedString(value: Readonly<Record<string, unknown>>, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current) || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}
