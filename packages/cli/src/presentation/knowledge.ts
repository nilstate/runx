import { theme } from "../ui.js";

export function renderKnowledgeProjections(
  project: string,
  projections: readonly {
    readonly key: string;
    readonly value: unknown;
    readonly scope: string;
    readonly source: string;
    readonly confidence: number;
    readonly freshness: string;
    readonly receipt_id?: string;
  }[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const t = theme(undefined, env);
  if (projections.length === 0) {
    return `\n  ${t.dim}No knowledge projections for ${project}.${t.reset}\n\n`;
  }
  const keyWidth = Math.min(32, Math.max(...projections.map((projection) => projection.key.length)));
  const lines: string[] = [""];
  lines.push(`  ${t.dim}${project}${t.reset}`);
  lines.push("");
  for (const projection of projections) {
    const value = typeof projection.value === "string" ? projection.value : JSON.stringify(projection.value);
    lines.push(`  ${t.bold}${projection.key.padEnd(keyWidth)}${t.reset}  ${value}  ${t.dim}· ${projection.scope}/${projection.source} ${projection.freshness}${t.reset}`);
  }
  lines.push("");
  return lines.join("\n");
}
