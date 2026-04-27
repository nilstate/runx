import { flattenConfig, type ConfigResult } from "../commands/config.js";
import { renderKeyValue, theme } from "../ui.js";

export function renderConfigResult(result: ConfigResult, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(undefined, env);
  if (result.action === "list") {
    const entries = flattenConfig(result.values);
    if (entries.length === 0) return `\n  ${t.dim}No config values set.${t.reset}\n\n`;
    return renderKeyValue("config", "success", entries, t);
  }
  const value = String(result.value ?? "");
  return renderKeyValue("config", "success", [[result.key, value]], t);
}
