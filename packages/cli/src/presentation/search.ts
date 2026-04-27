import type { SkillSearchResult } from "@runxhq/core/marketplaces";
import type { ToolCatalogSearchResult, ToolInspectResult } from "@runxhq/runtime-local/tool-catalogs";

import { theme } from "../ui.js";

export function renderSearchResults(results: readonly SkillSearchResult[], env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(undefined, env);
  if (results.length === 0) {
    return `\n  ${t.dim}No skills found.${t.reset}\n\n`;
  }
  const lines: string[] = [""];
  for (const result of results) {
    const tier = result.source_type === "bundled" ? "bundled" : result.source_label;
    lines.push(`  ${t.magenta}${t.bold}${result.skill_id}${t.reset}  ${t.dim}· ${tier} · ${result.trust_tier}${t.reset}`);
    if (result.summary) {
      lines.push(`  ${t.dim}${result.summary}${t.reset}`);
    }
    if (result.profile_mode === "profiled" && result.runner_names.length > 0) {
      lines.push(`  ${t.dim}runners:${t.reset} ${result.runner_names.join(", ")}`);
    }
    lines.push(`  ${t.dim}run${t.reset}  ${t.cyan}${result.run_command}${t.reset}`);
    lines.push(`  ${t.dim}add${t.reset}  ${result.add_command}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function renderToolSearchResults(
  results: readonly ToolCatalogSearchResult[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const t = theme(process.stdout, env);
  if (results.length === 0) {
    return `\n  ${t.dim}No imported tools found.${t.reset}\n\n`;
  }

  const lines = ["", `  ${t.bold}Imported Tools${t.reset}`];
  for (const result of results) {
    lines.push(
      `  ${t.bold}${result.name}${t.reset}  ${t.dim}${result.source_label}${t.reset}`,
      `  ${t.dim}type${t.reset}      ${result.source_type}`,
      `  ${t.dim}namespace${t.reset} ${result.namespace}`,
      `  ${t.dim}external${t.reset}  ${result.external_name}`,
      `  ${t.dim}catalog${t.reset}   ${result.catalog_ref}`,
    );
    if (result.required_scopes.length > 0) {
      lines.push(`  ${t.dim}scopes${t.reset}    ${result.required_scopes.join(", ")}`);
    }
    if (result.summary) {
      lines.push(`  ${t.dim}summary${t.reset}   ${result.summary}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function renderToolInspectResult(
  result: ToolInspectResult,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const t = theme(process.stdout, env);
  const lines = [
    "",
    `  ${t.bold}${result.name}${t.reset}  ${t.dim}${result.provenance.origin}${t.reset}`,
    `  ${t.dim}exec${t.reset}      ${result.execution_source_type}`,
    `  ${t.dim}path${t.reset}      ${result.reference_path}`,
    `  ${t.dim}root${t.reset}      ${result.skill_directory}`,
  ];

  if (result.provenance.origin === "imported") {
    lines.push(
      `  ${t.dim}catalog${t.reset}   ${result.provenance.catalog_ref ?? "unknown"}`,
      `  ${t.dim}source${t.reset}    ${result.provenance.source_label ?? result.provenance.source ?? "unknown"}`,
      `  ${t.dim}kind${t.reset}      ${result.provenance.source_type ?? "unknown"}`,
      `  ${t.dim}external${t.reset}  ${result.provenance.external_name ?? "unknown"}`,
    );
  }

  if (result.scopes.length > 0) {
    lines.push(`  ${t.dim}scopes${t.reset}    ${result.scopes.join(", ")}`);
  }
  if (result.description) {
    lines.push(`  ${t.dim}summary${t.reset}   ${result.description}`);
  }

  const inputEntries = Object.entries(result.inputs);
  if (inputEntries.length > 0) {
    lines.push(`  ${t.dim}inputs${t.reset}`);
    for (const [name, input] of inputEntries) {
      const pieces = [input.type, input.required ? "required" : "optional"];
      if (input.description) {
        pieces.push(input.description);
      }
      lines.push(`    ${name}: ${pieces.join(" · ")}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}
