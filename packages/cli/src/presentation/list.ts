import type { RunxListItem, RunxListReport } from "../commands/list.js";
import { statusIcon, theme } from "../ui.js";

export function renderListResult(result: RunxListReport, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(process.stdout, env);
  const lines = [""];
  for (const kind of ["tool", "skill", "graph", "packet", "overlay"] as const) {
    const items = result.items.filter((item) => item.kind === kind);
    if (items.length === 0) {
      continue;
    }
    lines.push(`  ${t.bold}${kind}s${t.reset}`);
    for (const item of items) {
      const status = item.status === "ok" ? statusIcon("success", t) : statusIcon("failure", t);
      const detail = renderListItemDetail(item);
      lines.push(`  ${status}  ${item.name.padEnd(28)} ${t.dim}${item.source.padEnd(12)}${t.reset} ${detail}`);
    }
    lines.push("");
  }
  if (lines.length === 1) {
    lines.push(`  ${t.dim}No runx authoring primitives found.${t.reset}`, "");
  }
  return lines.join("\n");
}

function renderListItemDetail(item: RunxListItem): string {
  if (item.status === "invalid") {
    return `invalid: ${(item.diagnostics ?? []).join(", ")}`;
  }
  if (item.kind === "tool") {
    const scopes = item.scopes?.join(", ") || "no scopes";
    const emits = item.emits?.map((emit) => emit.packet ? `${emit.name}:${emit.packet}` : emit.name).join(", ");
    return `${scopes}${emits ? `  emits ${emits}` : ""}`;
  }
  if (item.kind === "graph") {
    return `${item.steps ?? 0} steps${renderCoverageDetail(item)}`;
  }
  if (item.kind === "skill") {
    return `skill${renderCoverageDetail(item)}`;
  }
  if (item.kind === "overlay") {
    return item.wraps ? `wraps ${item.wraps}` : "overlay";
  }
  return item.path;
}

function renderCoverageDetail(item: RunxListItem): string {
  const parts: string[] = [];
  if (item.fixtures !== undefined) {
    parts.push(`${item.fixtures} fixture${item.fixtures === 1 ? "" : "s"}`);
  }
  if (item.harness_cases !== undefined) {
    parts.push(`${item.harness_cases} harness case${item.harness_cases === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? `, ${parts.join(", ")}` : "";
}
