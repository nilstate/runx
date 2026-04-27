import { preferredRunCommand } from "../skill-refs.js";
import { renderKeyValue, theme } from "../ui.js";

export function renderInstallResult(
  result: {
    readonly status: "installed" | "unchanged";
    readonly skill_name: string;
    readonly destination: string;
    readonly source_label: string;
    readonly version?: string;
    readonly runnerNames: readonly string[];
    readonly trust_tier?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const t = theme(undefined, env);
  return renderKeyValue(
    result.skill_name,
    result.status,
    [
      ["source", result.source_label],
      ["version", result.version],
      ["trust", result.trust_tier],
      ["runners", result.runnerNames.length > 0 ? result.runnerNames.join(", ") : "portable"],
      ["path", result.destination],
      ["next", preferredRunCommand(result.skill_name)],
    ],
    t,
  );
}

export function renderPublishResult(
  result: {
    readonly status: "published" | "unchanged";
    readonly skill_id: string;
    readonly version: string;
    readonly digest: string;
    readonly runner_names: readonly string[];
    readonly link: { readonly install_command?: string; readonly run_command?: string };
    readonly harness?: {
      readonly status: "passed" | "failed" | "not_declared";
      readonly case_count: number;
    };
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const t = theme(undefined, env);
  return renderKeyValue(
    `${result.skill_id}@${result.version}`,
    result.status,
    [
      ["digest", `sha256:${result.digest.slice(0, 12)}…`],
      ["runners", result.runner_names.length > 0 ? result.runner_names.join(", ") : "portable"],
      ["harness", result.harness ? `${result.harness.status} · ${result.harness.case_count} case${result.harness.case_count === 1 ? "" : "s"}` : "not checked"],
      ["install", result.link.install_command],
      ["run", result.link.run_command],
    ],
    t,
  );
}
