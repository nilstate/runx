import { resolvePathFromUserInput } from "@runxhq/core/config";
import {
  diffLocalRuns,
  inspectLocalReceipt,
  listLocalHistory,
  readLocalReplaySeed,
  type LocalReceiptSummary,
  type RunSummaryDiff,
} from "@runxhq/runtime-local";

import { renderKeyValue, relativeTime, shortId, statusIcon, theme } from "../ui.js";

export interface InspectCommandArgs {
  readonly receiptId: string;
  readonly receiptDir?: string;
}

export interface HistoryCommandArgs {
  readonly receiptDir?: string;
  readonly historyQuery?: string;
  readonly historySkill?: string;
  readonly historyStatus?: string;
  readonly historySource?: string;
  readonly historyActor?: string;
  readonly historyArtifactType?: string;
  readonly historySince?: string;
  readonly historyUntil?: string;
}

export interface ReplayCommandArgs {
  readonly replayRef: string;
  readonly receiptDir?: string;
}

export interface DiffCommandArgs {
  readonly diffLeft: string;
  readonly diffRight: string;
  readonly receiptDir?: string;
}

export async function handleInspectCommand(
  parsed: InspectCommandArgs,
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof inspectLocalReceipt>>> {
  return await inspectLocalReceipt({
    receiptId: parsed.receiptId,
    receiptDir: parsed.receiptDir ? resolvePathFromUserInput(parsed.receiptDir, env) : undefined,
    env,
  });
}

export async function handleHistoryCommand(
  parsed: HistoryCommandArgs,
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof listLocalHistory>>> {
  return await listLocalHistory({
    receiptDir: parsed.receiptDir ? resolvePathFromUserInput(parsed.receiptDir, env) : undefined,
    env,
    query: parsed.historyQuery,
    skill: parsed.historySkill,
    status: parsed.historyStatus,
    sourceType: parsed.historySource,
    actor: parsed.historyActor,
    artifactType: parsed.historyArtifactType,
    sinceMs: parseDateFilter(parsed.historySince, "--since"),
    untilMs: parseDateFilter(parsed.historyUntil, "--until"),
  });
}

export async function handleReplaySeedCommand(
  parsed: ReplayCommandArgs,
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof readLocalReplaySeed>>> {
  return await readLocalReplaySeed({
    referenceId: parsed.replayRef,
    receiptDir: parsed.receiptDir ? resolvePathFromUserInput(parsed.receiptDir, env) : undefined,
    env,
  });
}

export async function handleDiffCommand(
  parsed: DiffCommandArgs,
  env: NodeJS.ProcessEnv,
): Promise<RunSummaryDiff> {
  return await diffLocalRuns({
    left: parsed.diffLeft,
    right: parsed.diffRight,
    receiptDir: parsed.receiptDir ? resolvePathFromUserInput(parsed.receiptDir, env) : undefined,
    env,
  });
}

export function renderReceiptInspection(summary: LocalReceiptSummary, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(undefined, env);
  const rows: Array<[string, string]> = [
    ["id", summary.id],
    ["kind", summary.kind],
    ["status", summary.status],
  ];
  if (summary.sourceType) rows.push(["source", summary.sourceType]);
  if (summary.disposition) rows.push(["disposition", summary.disposition]);
  if (summary.outcomeState) rows.push(["outcome", summary.outcomeState]);
  if (summary.startedAt) rows.push(["started", relativeTime(summary.startedAt)]);
  if (summary.completedAt) rows.push(["completed", relativeTime(summary.completedAt)]);
  if (summary.actors && summary.actors.length > 0) rows.push(["actors", summary.actors.join(", ")]);
  if (summary.artifactTypes && summary.artifactTypes.length > 0) rows.push(["artifacts", summary.artifactTypes.join(", ")]);
  if (summary.runnerProvider) rows.push(["runner", summary.runnerProvider]);
  if (summary.approval?.decision) rows.push(["approval", `${summary.approval.decision}${summary.approval.gateType ? ` · ${summary.approval.gateType}` : ""}`]);
  if (summary.lineage) rows.push(["lineage", `${summary.lineage.kind} of ${summary.lineage.sourceRunId}`]);
  if (summary.verification) rows.push(["verify", `${summary.verification.status}${summary.verification.reason ? ` (${summary.verification.reason})` : ""}`]);
  rows.push(["history", "runx history"]);
  rows.push(["replay", `runx replay ${summary.id}`]);
  rows.push(["json", `runx inspect ${summary.id} --json`]);
  return renderKeyValue(summary.name, summary.status, rows, t);
}

export function renderHistory(
  receipts: readonly LocalReceiptSummary[],
  env: NodeJS.ProcessEnv = process.env,
  query?: string,
): string {
  const t = theme(undefined, env);
  if (receipts.length === 0) {
    return query
      ? `\n  ${t.dim}No receipts matched ${t.cyan}${query}${t.reset}${t.dim}.${t.reset}\n  ${t.dim}Try ${t.cyan}runx history${t.reset}${t.dim} to see every local run.${t.reset}\n\n`
      : `\n  ${t.dim}No receipts yet. Try a run first:${t.reset}\n  ${t.cyan}runx evolve${t.reset}\n  ${t.cyan}runx search docs${t.reset}\n\n`;
  }
  const now = Date.now();
  const nameWidth = Math.min(32, Math.max(...receipts.map((receipt) => receipt.name.length)));
  const lines: string[] = [""];
  lines.push(`  ${t.bold}history${t.reset}${query ? `  ${t.dim}· ${query}${t.reset}` : ""}  ${t.dim}${receipts.length} receipt(s)${t.reset}`);
  lines.push("");
  for (const summary of receipts) {
    const icon = statusIcon(summary.status, t);
    const name = summary.name.padEnd(nameWidth);
    const when = summary.startedAt ? relativeTime(summary.startedAt, now) : "";
    const source = summary.sourceType ?? summary.kind;
    const id = shortId(summary.id);
    const verification = summary.verification?.status ?? "unknown";
    lines.push(
      `  ${icon}  ${t.bold}${name}${t.reset}  ${t.dim}${source.padEnd(16)}${t.reset}  ${t.dim}${verification.padEnd(10)}${t.reset}  ${t.dim}${when.padEnd(10)}${t.reset}  ${t.dim}${id}${t.reset}`,
    );
  }
  lines.push("");
  lines.push(`  ${t.dim}next${t.reset}  runx inspect <receipt-id>`);
  lines.push("");
  return lines.join("\n");
}

export function renderRunDiff(diff: RunSummaryDiff, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(undefined, env);
  const lines: string[] = [""];
  lines.push(`  ${t.bold}diff${t.reset}  ${t.dim}${shortId(diff.left.id)} -> ${shortId(diff.right.id)}${t.reset}`);
  lines.push(`  ${t.dim}${diff.left.name}${t.reset}  ${t.dim}vs${t.reset}  ${t.dim}${diff.right.name}${t.reset}`);
  lines.push("");
  if (!diff.changed) {
    lines.push(`  ${t.dim}No material run deltas found.${t.reset}`);
  } else {
    for (const [field, delta] of Object.entries(diff.fields)) {
      lines.push(`  ${t.bold}${field}${t.reset}  ${formatDeltaValue(delta.left)} -> ${formatDeltaValue(delta.right)}`);
    }
    if (diff.actors.added.length > 0 || diff.actors.removed.length > 0) {
      lines.push(`  ${t.bold}actors${t.reset}  +${diff.actors.added.join(", ") || "none"}  -${diff.actors.removed.join(", ") || "none"}`);
    }
    if (diff.artifactTypes.added.length > 0 || diff.artifactTypes.removed.length > 0) {
      lines.push(`  ${t.bold}artifacts${t.reset}  +${diff.artifactTypes.added.join(", ") || "none"}  -${diff.artifactTypes.removed.join(", ") || "none"}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function parseDateFilter(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid date for ${flag}: ${value}`);
  }
  return ms;
}

function formatDeltaValue(value: unknown): string {
  if (value === undefined) {
    return "none";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}
