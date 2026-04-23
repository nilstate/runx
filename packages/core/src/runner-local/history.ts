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
  const { receipt, verification } = await readVerifiedLocalReceipt(
    options.receiptDir ?? defaultReceiptDir(options.env),
    options.receiptId,
    options.runxHome ?? options.env?.RUNX_HOME,
  );
  return {
    receipt,
    verification,
    summary: summarizeLocalReceipt(receipt, verification),
  };
}

export async function listLocalHistory(options: ListLocalHistoryOptions = {}): Promise<ListLocalHistoryResult> {
  const receipts = await listVerifiedLocalReceipts(
    options.receiptDir ?? defaultReceiptDir(options.env),
    options.runxHome ?? options.env?.RUNX_HOME,
  );
  const normalizedQuery = options.query?.trim().toLowerCase();
  const skillFilter = options.skill?.trim().toLowerCase();
  const statusFilter = options.status?.trim().toLowerCase();
  const sourceFilter = options.sourceType?.trim().toLowerCase();
  const sinceMs = options.sinceMs;
  const untilMs = options.untilMs;
  return {
    receipts: receipts
      .map(({ receipt, verification }) => summarizeLocalReceipt(receipt, verification))
      .filter((summary) => {
        if (normalizedQuery) {
          const matchesQuery =
            summary.name.toLowerCase().includes(normalizedQuery) ||
            summary.id.toLowerCase().includes(normalizedQuery) ||
            (summary.sourceType?.toLowerCase().includes(normalizedQuery) ?? false);
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

function summarizeLocalReceipt(receipt: LocalReceipt, verification: ReceiptVerification): LocalReceiptSummary {
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
  };
}
