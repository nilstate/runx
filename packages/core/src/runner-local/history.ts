import {
  SYSTEM_ARTIFACT_TYPES,
  readLedgerEntries,
} from "../artifacts/index.js";
import {
  listVerifiedLocalReceipts,
  readVerifiedLocalReceipt,
  type LocalGraphReceipt,
  type LocalReceipt,
  type ReceiptVerification,
} from "../receipts/index.js";
import { defaultReceiptDir } from "./receipt-paths.js";

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
  readonly summary: LocalReceiptSummary;
}

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
}

export interface LocalReceiptSummary {
  readonly id: string;
  readonly kind: LocalReceipt["kind"];
  readonly status: LocalReceipt["status"];
  readonly verification: ReceiptVerification;
  readonly name: string;
  readonly sourceType?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly actors?: readonly string[];
  readonly artifactTypes?: readonly string[];
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
  return {
    receipt,
    verification,
    summary: await summarizeLocalReceipt(receipt, verification, receiptDir),
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
  return {
    receipts: summaries
      .filter((summary) => {
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
      })
      .slice(0, options.limit ?? receipts.length),
  };
}

async function summarizeLocalReceipt(
  receipt: LocalReceipt,
  verification: ReceiptVerification,
  receiptDir: string,
): Promise<LocalReceiptSummary> {
  const actors = extractReceiptActors(receipt);
  const artifactTypes = await extractReceiptArtifactTypes(receipt, receiptDir);
  if (receipt.kind === "skill_execution") {
    return {
      id: receipt.id,
      kind: receipt.kind,
      status: receipt.status,
      verification,
      name: receipt.skill_name,
      sourceType: receipt.source_type,
      startedAt: receipt.started_at,
      completedAt: receipt.completed_at,
      actors,
      artifactTypes,
    };
  }

  return {
    id: receipt.id,
    kind: receipt.kind,
    status: receipt.status,
    verification,
    name: receipt.graph_name,
    startedAt: receipt.started_at,
    completedAt: receipt.completed_at,
    actors,
    artifactTypes,
  };
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

async function extractReceiptArtifactTypes(receipt: LocalReceipt, receiptDir: string): Promise<readonly string[] | undefined> {
  const ledgerEntries = await readLedgerEntries(receiptDir, receipt.id);
  const directArtifactIds = receipt.kind === "skill_execution" && Array.isArray(receipt.artifact_ids)
    ? new Set(receipt.artifact_ids)
    : undefined;
  const artifactTypes = ledgerEntries
    .filter((entry) => entry.type !== null && !SYSTEM_ARTIFACT_TYPES.has(entry.type))
    .filter((entry) => !directArtifactIds || directArtifactIds.has(entry.meta.artifact_id))
    .map((entry) => entry.type as string);
  return artifactTypes.length > 0 ? Array.from(new Set(artifactTypes)) : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
