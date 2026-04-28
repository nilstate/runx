import { readLedgerEntries, type ArtifactEnvelope } from "@runxhq/core/artifacts";
import {
  defaultRunxHome,
  listVerifiedLocalReceipts,
  latestVerifiedReceiptOutcomeResolution,
  type GovernedDisposition,
  type LocalReceipt,
  type ReceiptVerification,
  type ReceiptSurfaceRef,
  type VerifiedReceiptOutcomeResolution,
} from "@runxhq/core/receipts";
import type { OutcomeState } from "@runxhq/core/receipts";
import { isRecord } from "@runxhq/core/util";

export const TRAINING_SCHEMA_REFS = {
  trainable_receipt_row: "https://runx.ai/spec/training/trainable-receipt-row.schema.json",
} as const;

export interface StreamTrainableReceiptsOptions {
  readonly receiptDir: string;
  readonly runxHome?: string;
  readonly since?: string;
  readonly until?: string;
  readonly status?: string;
  readonly source?: string;
}

export interface TrainableReceiptRow {
  readonly kind: "runx.trainable-receipt-row.v1";
  readonly exported_at: string;
  readonly receipt_id: string;
  readonly receipt_kind: LocalReceipt["kind"];
  readonly skill_name: string | null;
  readonly graph_name: string | null;
  readonly owner: string | null;
  readonly source_type: string | null;
  readonly status: LocalReceipt["status"];
  readonly disposition: GovernedDisposition | null;
  readonly effective_outcome_state: OutcomeState;
  readonly input_context: LocalReceipt["input_context"] | null;
  readonly surface_refs: readonly ReceiptSurfaceRef[];
  readonly evidence_refs: readonly ReceiptSurfaceRef[];
  readonly context_from: readonly string[];
  readonly artifact_ids: readonly string[];
  readonly receipt: LocalReceipt;
  readonly receipt_verification: ReceiptVerification;
  readonly latest_outcome_resolution: VerifiedReceiptOutcomeResolution | null;
  readonly ledger_entries: readonly ArtifactEnvelope[];
  readonly runner_provenance: {
    readonly provider?: string;
    readonly model?: string;
    readonly prompt_version?: string;
  };
}

export async function* streamTrainableReceipts(
  options: StreamTrainableReceiptsOptions,
): AsyncGenerator<TrainableReceiptRow> {
  const since = parseTimestamp(options.since, "since");
  const until = parseTimestamp(options.until, "until");
  const receipts = await listVerifiedLocalReceipts(options.receiptDir, options.runxHome);

  for (const { receipt, verification } of receipts) {
    if (verification.status !== "verified") {
      continue;
    }

    const timestamp = receiptTimestamp(receipt);
    if (since && (!timestamp || timestamp < since)) {
      continue;
    }
    if (until && (!timestamp || timestamp > until)) {
      continue;
    }

    const latestOutcomeResolution = await latestVerifiedReceiptOutcomeResolution(
      options.receiptDir,
      receipt.id,
      options.runxHome ?? defaultRunxHome(),
    );
    const effectiveOutcomeState = latestOutcomeResolution?.resolution.outcome_state ?? receipt.outcome_state ?? "complete";
    if (options.status && effectiveOutcomeState !== options.status) {
      continue;
    }

    const receiptSource = sourceType(receipt);
    if (options.source && receiptSource !== options.source) {
      continue;
    }

    yield projectTrainableReceiptRow({
      receipt,
      verification,
      effectiveOutcomeState,
      latestOutcomeResolution: latestOutcomeResolution ?? null,
      ledgerEntries: await readLedgerEntries(options.receiptDir, receipt.id),
      runnerProvenance: runnerProvenance(receipt),
      exportedAt: new Date().toISOString(),
    });
  }
}

export function projectTrainableReceiptRow(options: {
  readonly receipt: LocalReceipt;
  readonly verification: ReceiptVerification;
  readonly effectiveOutcomeState: OutcomeState;
  readonly latestOutcomeResolution: VerifiedReceiptOutcomeResolution | null;
  readonly ledgerEntries: readonly ArtifactEnvelope[];
  readonly runnerProvenance: TrainableReceiptRow["runner_provenance"];
  readonly exportedAt: string;
}): TrainableReceiptRow {
  const { receipt } = options;
  return {
    kind: "runx.trainable-receipt-row.v1",
    exported_at: options.exportedAt,
    receipt_id: receipt.id,
    receipt_kind: receipt.kind,
    skill_name: receipt.kind === "skill_execution" ? receipt.skill_name : null,
    graph_name: receipt.kind === "graph_execution" ? receipt.graph_name : null,
    owner: receipt.kind === "graph_execution" ? receipt.owner ?? null : null,
    source_type: receipt.kind === "skill_execution" ? receipt.source_type : null,
    status: receipt.status,
    disposition: receipt.disposition ?? null,
    effective_outcome_state: options.effectiveOutcomeState,
    input_context: receipt.input_context ?? null,
    surface_refs: receipt.surface_refs ?? [],
    evidence_refs: receipt.evidence_refs ?? [],
    context_from: collectContextFrom(receipt),
    artifact_ids: collectArtifactIds(receipt),
    receipt,
    receipt_verification: options.verification,
    latest_outcome_resolution: options.latestOutcomeResolution,
    ledger_entries: options.ledgerEntries,
    runner_provenance: options.runnerProvenance,
  };
}

function collectContextFrom(receipt: LocalReceipt): readonly string[] {
  if (receipt.kind === "skill_execution") {
    return receipt.context_from;
  }
  return receipt.steps.flatMap((step) =>
    step.context_from.map((entry) => entry.receipt_id ?? `${entry.from_step}:${entry.output}`),
  );
}

function collectArtifactIds(receipt: LocalReceipt): readonly string[] {
  if (receipt.kind === "skill_execution") {
    return receipt.artifact_ids ?? [];
  }
  return receipt.steps.flatMap((step) => step.artifact_ids ?? []);
}

function receiptTimestamp(receipt: LocalReceipt): number | undefined {
  const raw = receipt.completed_at ?? receipt.started_at;
  if (!raw) {
    return undefined;
  }
  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function parseTimestamp(value: string | undefined, label: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid ${label} timestamp '${value}'. Expected ISO-8601.`);
  }
  return timestamp;
}

function sourceType(receipt: LocalReceipt): string | undefined {
  return receipt.kind === "skill_execution" ? receipt.source_type : undefined;
}

function runnerProvenance(receipt: LocalReceipt): TrainableReceiptRow["runner_provenance"] {
  const metadata = receipt.kind === "skill_execution" && isRecord(receipt.metadata) ? receipt.metadata : undefined;
  const runner = isRecord(metadata?.runner) ? metadata.runner : undefined;
  return {
    provider: typeof runner?.provider === "string" ? runner.provider : undefined,
    model: typeof runner?.model === "string" ? runner.model : undefined,
    prompt_version: typeof runner?.prompt_version === "string" ? runner.prompt_version : undefined,
  };
}
