import type { InitResult } from "../commands/init.js";
import type { NewResult } from "../commands/new.js";
import { renderKeyValue, theme } from "../ui.js";

export function renderNewResult(result: NewResult, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(undefined, env);
  return renderKeyValue(
    "runx new",
    "success",
    [
      ["package", result.name],
      ["packet_namespace", result.packet_namespace],
      ["directory", result.directory],
      ["files", String(result.files.length)],
      ["next", result.next_steps.join(" && ")],
    ],
    t,
  );
}

export function renderInitResult(result: InitResult, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(undefined, env);
  return renderKeyValue(
    result.action === "global" ? "runx global init" : "runx project init",
    "success",
    [
      ["created", result.created ? "yes" : "no"],
      ["project", result.project_dir],
      ["project_id", result.project_id],
      ["home", result.global_home_dir],
      ["installation_id", result.installation_id],
      ["official_cache", result.official_cache_dir],
    ],
    t,
  );
}
