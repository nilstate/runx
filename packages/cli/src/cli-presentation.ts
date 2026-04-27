import { runHarness, runHarnessTarget } from "@runxhq/runtime-local/harness";
import type { ExecutionEvent } from "@runxhq/runtime-local";

import type { CliIo } from "./index.js";
import { renderKeyValue, statusIcon, theme } from "./ui.js";
import { humanizeLabel, isRecord } from "./presentation/internal.js";
import { humanizeExpectedOutput } from "./presentation/needs-resolution.js";

export { renderListResult } from "./presentation/list.js";
export { renderConfigResult } from "./presentation/config.js";
export { renderNewResult, renderInitResult } from "./presentation/init-new.js";
export { renderSearchResults, renderToolSearchResults, renderToolInspectResult } from "./presentation/search.js";
export { renderInstallResult, renderPublishResult } from "./presentation/install-publish.js";
export { renderKnowledgeProjections } from "./presentation/knowledge.js";
export { renderNeedsResolution, renderPolicyDenied } from "./presentation/needs-resolution.js";
export { writeLocalSkillResult } from "./presentation/run-result.js";

export function renderExecutionEvent(event: ExecutionEvent, io: CliIo, env: NodeJS.ProcessEnv): string | undefined {
  const t = theme(io.stdout, env);
  const detail = isRecord(event.data) ? event.data : undefined;
  if (event.type === "step_started") {
    const stepId = typeof detail?.stepId === "string" ? detail.stepId : undefined;
    const stepLabel = typeof detail?.stepLabel === "string" ? detail.stepLabel : undefined;
    const skill = typeof detail?.skill === "string" ? detail.skill : undefined;
    if (!stepId) return undefined;
    return `  ${t.yellow}◇${t.reset}  ${t.bold}${humanizeLabel(stepLabel ?? stepId)}${t.reset}${skill ? `  ${t.dim}${skill}${t.reset}` : ""}\n`;
  }
  if (event.type === "step_waiting_resolution") {
    const stepId = typeof detail?.stepId === "string" ? detail.stepId : undefined;
    const stepLabel = typeof detail?.stepLabel === "string" ? detail.stepLabel : undefined;
    const kinds = Array.isArray(detail?.kinds) ? detail.kinds.filter((entry): entry is string => typeof entry === "string") : [];
    const resolutionSkills = Array.isArray(detail?.resolutionSkills)
      ? detail.resolutionSkills.filter((entry): entry is string => typeof entry === "string")
      : [];
    const expectedOutputs = Array.isArray(detail?.expectedOutputs)
      ? detail.expectedOutputs.filter((entry): entry is string => typeof entry === "string").map((entry) => humanizeExpectedOutput(entry))
      : [];
    const sourceySkill = resolutionSkills[0];
    const sourceyLabel =
      sourceySkill === "sourcey.discover"
        ? "needs docs plan"
        : sourceySkill === "sourcey.author"
          ? "needs docs bundle"
          : sourceySkill === "sourcey.critique"
            ? "needs site review"
            : sourceySkill === "sourcey.revise"
              ? "needs docs revision"
              : undefined;
    const label =
      kinds.length === 1 && kinds[0] === "approval"
        ? "needs approval"
        : kinds.length === 1 && kinds[0] === "input"
          ? "needs input"
          : sourceyLabel
            ? sourceyLabel
            : `needs ${expectedOutputs.length === 1 ? expectedOutputs[0] : expectedOutputs.length > 1 ? "expected outputs" : "drafted output"}`;
    return stepId
      ? `  ${t.yellow}◇${t.reset}  ${t.bold}${humanizeLabel(stepLabel ?? stepId)}${t.reset}  ${t.dim}${label}${t.reset}\n`
      : undefined;
  }
  if (event.type === "step_completed") {
    const stepId = typeof detail?.stepId === "string" ? detail.stepId : undefined;
    const stepLabel = typeof detail?.stepLabel === "string" ? detail.stepLabel : undefined;
    const status = detail?.status === "failure" ? "failure" : "success";
    if (!stepId) return undefined;
    return `  ${statusIcon(status, t)}  ${t.bold}${humanizeLabel(stepLabel ?? stepId)}${t.reset}  ${t.dim}${status}${t.reset}\n`;
  }
  if (event.type === "resolution_requested" || event.type === "resolution_resolved") {
    return undefined;
  }
  return undefined;
}

export function renderCliError(message: string): string {
  const t = theme(process.stderr);
  const icon = statusIcon("failure", t);
  let hint = "";
  if (/ENOENT.*SKILL\.md/i.test(message) && !/Try/.test(message)) {
    hint = `\n  ${t.dim}Pass a skill name or directory path.${t.reset}`;
  }
  return `\n  ${icon}  ${message}${hint}\n\n`;
}

export function renderHarnessResult(
  result:
    | Awaited<ReturnType<typeof runHarness>>
    | Awaited<ReturnType<typeof runHarnessTarget>>,
): string {
  const t = theme();
  if ("cases" in result) {
    const lines = [
      "",
      `  ${statusIcon(result.status, t)}  ${t.bold}harness suite${t.reset}  ${t.dim}${result.cases.length} case(s)${t.reset}`,
      "",
    ];
    for (const entry of result.cases) {
      lines.push(`  ${statusIcon(entry.status, t)}  ${entry.fixture.name}  ${t.dim}${entry.assertionErrors.length} error(s)${t.reset}`);
    }
    if (result.assertionErrors.length > 0) {
      lines.push("");
      lines.push(`  ${t.dim}next${t.reset}  runx harness ${result.skillPath ?? result.targetPath} --json`);
    }
    lines.push("");
    return lines.join("\n");
  }
  return renderKeyValue(
    result.fixture.name,
    result.status,
    [
      ["kind", result.fixture.kind],
      ["target", result.targetPath],
      ["assertions", String(result.assertionErrors.length)],
    ],
    t,
  );
}
