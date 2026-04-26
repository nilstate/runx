import { existsSync } from "node:fs";
import path from "node:path";

import { runHarness, runHarnessTarget } from "@runxhq/core/harness";
import type { SkillSearchResult } from "@runxhq/core/marketplaces";
import type { ResolutionRequest } from "@runxhq/core/executor";
import type { ExecutionEvent, RunLocalSkillResult } from "@runxhq/core/runner-local";
import type { ToolCatalogSearchResult, ToolInspectResult } from "@runxhq/core/tool-catalogs";

import type { CliIo, ParsedArgs } from "./index.js";
import { flattenConfig, type ConfigResult } from "./commands/config.js";
import type { InitResult } from "./commands/init.js";
import type { RunxListItem, RunxListReport } from "./commands/list.js";
import type { NewResult } from "./commands/new.js";
import { preferredRunCommand } from "./skill-refs.js";
import { renderKeyValue, shortId, statusIcon, theme } from "./ui.js";

function humanizeLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expectedOutputLabels(requests: readonly ResolutionRequest[]): readonly string[] {
  return Array.from(
    new Set(
      requests
        .filter((request): request is Extract<ResolutionRequest, { kind: "cognitive_work" }> => request.kind === "cognitive_work")
        .flatMap((request) => Object.keys(request.work.envelope.expected_outputs ?? {}))
        .map((value) => humanizeExpectedOutput(value)),
    ),
  );
}

function humanizeExpectedOutput(value: string): string {
  switch (value) {
    case "discovery_report":
      return "docs plan";
    case "doc_bundle":
      return "docs bundle";
    case "evaluation_report":
      return "site review";
    case "revision_bundle":
      return "docs revision";
    case "spec_draft":
      return "spec draft";
    case "fix_draft":
      return "fix draft";
    case "review_decision":
      return "review";
    case "approval_decision":
      return "approval";
    default:
      return humanizeLabel(value);
  }
}

function firstCognitiveSkill(requests: readonly ResolutionRequest[]): string | undefined {
  return requests.find((request): request is Extract<ResolutionRequest, { kind: "cognitive_work" }> => request.kind === "cognitive_work")
    ?.work.envelope.skill;
}

function sourceyPauseCopy(
  requests: readonly ResolutionRequest[],
): { readonly headline: string; readonly body: string; readonly expected?: string } | undefined {
  const skill = firstCognitiveSkill(requests);
  if (skill === "sourcey.discover") {
    return {
      headline: "planning docs site",
      body: "Sourcey paused so it can inspect this repo and draft one bounded docs plan before it writes files or builds the site.",
      expected: "docs plan",
    };
  }
  if (skill === "sourcey.author") {
    return {
      headline: "drafting docs bundle",
      body: "Sourcey paused so it can draft the config and markdown bundle for the first build pass.",
      expected: "docs bundle",
    };
  }
  if (skill === "sourcey.critique") {
    return {
      headline: "reviewing built site",
      body: "Sourcey paused so it can review the built site once before the bounded revision pass.",
      expected: "site review",
    };
  }
  if (skill === "sourcey.revise") {
    return {
      headline: "applying docs revision",
      body: "Sourcey paused so it can apply one bounded docs revision before the final rebuild.",
      expected: "docs revision",
    };
  }
  return undefined;
}

function cognitiveNeedPhrase(requests: readonly ResolutionRequest[], skillName: string): string {
  const expected = expectedOutputLabels(requests);
  if (expected.length === 1) {
    return expected[0];
  }
  if (expected.length > 1) {
    return "expected outputs";
  }
  const tasks = Array.from(
    new Set(
      requests
        .filter((request): request is Extract<ResolutionRequest, { kind: "cognitive_work" }> => request.kind === "cognitive_work")
        .map((request) => {
          const task = request.work.task ?? request.work.envelope.step_id ?? request.work.envelope.skill;
          const prefix = `${skillName}-`;
          return task.startsWith(prefix) ? task.slice(prefix.length) : task;
        })
        .map((value) => humanizeLabel(value)),
    ),
  );
  return tasks[0] ?? "drafted output";
}

interface LocalAgentInstall {
  readonly command: string;
  readonly label: string;
}

function detectLocalAgents(env: NodeJS.ProcessEnv = process.env): readonly LocalAgentInstall[] {
  const candidates: readonly LocalAgentInstall[] = [
    { command: "claude", label: "Claude Code" },
    { command: "codex", label: "Codex" },
    { command: "gemini", label: "Gemini CLI" },
  ];
  return candidates.filter((candidate) => commandExistsOnPath(candidate.command, env));
}

function commandExistsOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const rawPath = env.PATH ?? "";
  if (!rawPath) return false;
  for (const directory of rawPath.split(path.delimiter)) {
    if (!directory) continue;
    if (existsSync(path.join(directory, command))) {
      return true;
    }
  }
  return false;
}

interface RunStateSummary {
  readonly skill: { readonly name: string };
  readonly runId: string;
  readonly stepIds?: readonly string[];
  readonly stepLabels?: readonly string[];
}

export function renderNeedsResolution(
  result: RunStateSummary & { readonly requests: readonly ResolutionRequest[] },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const t = theme(undefined, env);
  const icon = statusIcon("needs_resolution", t);
  const steps = (result.stepLabels ?? result.stepIds ?? []).map((value) => humanizeLabel(value)).join(", ");
  const kinds = Array.from(new Set(result.requests.map((request) => request.kind)));
  const cognitivePhrase = cognitiveNeedPhrase(result.requests, result.skill.name);
  const sourceyCopy = result.skill.name === "sourcey" ? sourceyPauseCopy(result.requests) : undefined;
  const headline =
    kinds.length === 1 && kinds[0] === "approval"
      ? "waiting for approval"
      : kinds.length === 1 && kinds[0] === "input"
        ? "waiting for input"
        : sourceyCopy?.headline
          ? sourceyCopy.headline
          : `waiting for ${cognitivePhrase}`;
  const localAgents = detectLocalAgents(env);
  const lines = [""];
  lines.push(`  ${icon}  ${t.bold}${result.skill.name}${t.reset}  ${t.dim}${headline}${t.reset}`);
  lines.push(`  ${t.dim}run${t.reset}   ${shortId(result.runId)}`);
  if (steps) {
    lines.push(`  ${t.dim}step${t.reset}  ${steps}`);
  }
  lines.push("");
  if (kinds.length === 1 && kinds[0] === "approval") {
    const approvals = result.requests
      .filter((request): request is Extract<ResolutionRequest, { kind: "approval" }> => request.kind === "approval")
      .map((request) => request.gate);
    lines.push(`  ${t.dim}This run is waiting for approval before it can continue.${t.reset}`);
    if (approvals.length > 0) {
      lines.push("");
      for (const gate of approvals) {
        lines.push(`  ${t.yellow}◇${t.reset}  ${t.bold}${gate.id}${t.reset}`);
        lines.push(`     ${t.dim}${gate.reason}${t.reset}`);
      }
    }
  } else if (kinds.length === 1 && kinds[0] === "input") {
    const inputs = result.requests
      .filter((request): request is Extract<ResolutionRequest, { kind: "input" }> => request.kind === "input")
      .flatMap((request) => request.questions);
    lines.push(`  ${t.dim}This run is waiting for required input before it can continue.${t.reset}`);
    if (inputs.length > 0) {
      lines.push("");
      for (const question of inputs) {
        lines.push(`  ${t.dim}·${t.reset} ${question.prompt}${question.description ? ` ${t.dim}(${question.id})${t.reset}` : ""}`);
      }
    }
  } else {
    const work = result.requests
      .filter((request): request is Extract<ResolutionRequest, { kind: "cognitive_work" }> => request.kind === "cognitive_work")
      .map((request) => {
        const task = request.work.task ?? request.work.envelope.step_id ?? request.work.envelope.skill;
        const prefix = `${result.skill.name}-`;
        return task.startsWith(prefix) ? task.slice(prefix.length) : task;
      });
    const expected = expectedOutputLabels(result.requests);
    lines.push(`  ${t.dim}${sourceyCopy?.body ?? `This run paused because the next step needs ${cognitivePhrase} before it can continue.`}${t.reset}`);
    if (expected.length > 0) {
      lines.push("");
      lines.push(`  ${t.dim}expected${t.reset}  ${sourceyCopy?.expected ?? expected.join(", ")}`);
    }
    if (work.length > 0) {
      if (expected.length === 0) {
        lines.push("");
      }
      for (const item of work) {
        lines.push(`  ${t.dim}task${t.reset}      ${humanizeLabel(item)}`);
      }
    }
  }
  if (kinds.includes("cognitive_work") && localAgents.length > 0) {
    lines.push(`  ${t.dim}Detected here:${t.reset} ${localAgents.map((agent) => agent.label).join(", ")}`);
    lines.push(`  ${t.dim}Best path:${t.reset} open this repo in ${localAgents.map((agent) => agent.label).join(" or ")} and run ${t.cyan}runx resume ${result.runId}${t.reset}${t.dim} there.${t.reset}`);
  } else if (kinds.includes("cognitive_work")) {
    lines.push(`  ${t.dim}Best path:${t.reset} run ${t.cyan}runx resume ${result.runId}${t.reset}${t.dim} from Codex or Claude Code, or script the step with ${t.cyan}--answers${t.reset}${t.dim}.${t.reset}`);
  } else if (kinds.includes("approval")) {
    lines.push(`  ${t.dim}Best path:${t.reset} run ${t.cyan}runx resume ${result.runId}${t.reset}${t.dim} to approve, or pass ${t.cyan}--answers${t.reset}${t.dim} with approval decisions.${t.reset}`);
  } else if (kinds.includes("input")) {
    lines.push(`  ${t.dim}Best path:${t.reset} run ${t.cyan}runx resume ${result.runId}${t.reset}${t.dim} to continue, or pass ${t.cyan}--input${t.reset}${t.dim} values.${t.reset}`);
  }
  lines.push("");
  lines.push(`  ${t.dim}Machine mode:${t.reset} ${t.dim}${t.cyan}--json${t.reset}${t.dim} prints the exact request envelope.${t.reset}`);
  lines.push("");
  return lines.join("\n");
}

export function renderPolicyDenied(
  skillName: string,
  reasons: readonly string[],
  receipt?: {
    readonly disposition?: string;
    readonly outcome_state?: string;
  },
): string {
  const t = theme(process.stderr);
  const icon = statusIcon("denied", t);
  const lines = [""];
  lines.push(`  ${icon}  ${t.bold}${skillName}${t.reset}  ${t.dim}policy denied${t.reset}`);
  if (receipt?.disposition) {
    lines.push(`  ${t.dim}disposition${t.reset}  ${receipt.disposition}`);
  }
  if (receipt?.outcome_state) {
    lines.push(`  ${t.dim}outcome${t.reset}      ${receipt.outcome_state}`);
  }
  for (const reason of reasons) {
    lines.push(`  ${t.dim}·${t.reset} ${reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

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

function formatDurationMs(durationMs: number | undefined): string | undefined {
  if (typeof durationMs !== "number" || Number.isNaN(durationMs)) return undefined;
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function extractOutputHighlights(stdout: string): Array<[string, string]> {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed.includes("\n") ? [] : [["output", trimmed]];
  }
  if (!isRecord(parsed)) return [];
  const output = isRecord(parsed.data) ? parsed.data : parsed;
  const fields: Array<[string, string]> = [];
  const push = (key: string, label = key) => {
    const value = output[key];
    if (value === undefined) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields.push([label, String(value)]);
    }
  };
  push("output_dir");
  push("index_path");
  push("command");
  push("verified");
  push("generated");
  push("contains_doctype");
  push("completed_state");
  push("review_path");
  push("spec_path");
  push("action");
  push("status");
  push("summary");
  push("issue");
  push("thread_locator", "thread");
  push("task_id", "task");
  push("lane");
  push("target_repo", "target");
  push("repo_root", "repo");
  push("preview_url", "preview");
  push("review_comment_url", "review");
  push("pull_request_url", "pr");
  return fields;
}

function truncateMultiline(text: string, maxLines = 8): string {
  const lines = text.trim().split("\n");
  if (lines.length <= maxLines) return lines.join("\n");
  return `${lines.slice(0, maxLines).join("\n")}\n…`;
}

function renderRunSuccess(
  result: {
    readonly skill: { readonly name: string };
    readonly execution: { readonly stdout: string };
    readonly receipt: {
      readonly id: string;
      readonly kind: string;
      readonly duration_ms: number;
      readonly disposition?: string;
      readonly outcome_state?: string;
      readonly steps?: readonly unknown[];
    };
  },
  io: CliIo,
  env: NodeJS.ProcessEnv,
): string {
  const t = theme(io.stdout, env);
  const trimmed = result.execution.stdout.trim();
  let parsedOutput: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      parsedOutput = parsed;
    }
  } catch {}
  if (result.skill.name === "sourcey" && parsedOutput) {
    const outputDir = typeof parsedOutput.output_dir === "string" ? parsedOutput.output_dir : undefined;
    const indexPath = typeof parsedOutput.index_path === "string" ? parsedOutput.index_path : undefined;
    const verified = typeof parsedOutput.verified === "boolean" ? (parsedOutput.verified ? "passed" : "failed") : undefined;
    const lines = [
      "",
      `  ${statusIcon("success", t)}  ${t.bold}sourcey${t.reset}  ${t.dim}site built${t.reset}`,
      `  ${t.dim}receipt${t.reset}   ${shortId(result.receipt.id)}`,
      `  ${t.dim}kind${t.reset}      ${result.receipt.kind}`,
    ];
    const duration = formatDurationMs(result.receipt.duration_ms);
    if (duration) lines.push(`  ${t.dim}duration${t.reset}  ${duration}`);
    if (outputDir) lines.push(`  ${t.dim}site${t.reset}      ${outputDir}`);
    if (indexPath) lines.push(`  ${t.dim}index${t.reset}     ${indexPath}`);
    if (verified) lines.push(`  ${t.dim}verify${t.reset}    ${verified}`);
    lines.push(`  ${t.dim}inspect${t.reset}   runx inspect ${result.receipt.id}`);
    lines.push("");
    return lines.join("\n");
  }
  const lines = [
    "",
    `  ${statusIcon("success", t)}  ${t.bold}${result.skill.name}${t.reset}  ${t.dim}success${t.reset}`,
    `  ${t.dim}receipt${t.reset}   ${shortId(result.receipt.id)}`,
    `  ${t.dim}kind${t.reset}      ${result.receipt.kind}`,
  ];
  const duration = formatDurationMs(result.receipt.duration_ms);
  if (duration) lines.push(`  ${t.dim}duration${t.reset}  ${duration}`);
  if (result.receipt.disposition) lines.push(`  ${t.dim}disposition${t.reset}  ${result.receipt.disposition}`);
  if (result.receipt.outcome_state) lines.push(`  ${t.dim}outcome${t.reset}      ${result.receipt.outcome_state}`);
  if (Array.isArray(result.receipt.steps)) {
    lines.push(`  ${t.dim}steps${t.reset}     ${result.receipt.steps.length}`);
  }
  const highlights = extractOutputHighlights(result.execution.stdout);
  for (const [label, value] of highlights) {
    lines.push(`  ${t.dim}${label}${t.reset}  ${value}`);
  }
  if (highlights.length === 0 && result.execution.stdout.trim()) {
    lines.push(`  ${t.dim}output${t.reset}    ${truncateMultiline(result.execution.stdout, 6)}`);
  }
  lines.push(`  ${t.dim}inspect${t.reset}   runx inspect ${result.receipt.id}`);
  lines.push("");
  return lines.join("\n");
}

function renderRunFailure(
  result: {
    readonly skill: { readonly name: string };
    readonly execution: { readonly stdout: string; readonly stderr: string; readonly errorMessage?: string };
    readonly receipt: {
      readonly id: string;
      readonly kind: string;
      readonly duration_ms: number;
      readonly disposition?: string;
      readonly outcome_state?: string;
      readonly steps?: readonly unknown[];
    };
  },
  io: CliIo,
  env: NodeJS.ProcessEnv,
): string {
  const t = theme(io.stderr, env);
  const status = result.receipt.disposition === "escalated" ? "escalated" : "failure";
  const lines = [
    "",
    `  ${statusIcon(status, t)}  ${t.bold}${result.skill.name}${t.reset}  ${t.dim}${status}${t.reset}`,
    `  ${t.dim}receipt${t.reset}   ${shortId(result.receipt.id)}`,
    `  ${t.dim}kind${t.reset}      ${result.receipt.kind}`,
  ];
  const duration = formatDurationMs(result.receipt.duration_ms);
  if (duration) lines.push(`  ${t.dim}duration${t.reset}  ${duration}`);
  if (result.receipt.disposition) lines.push(`  ${t.dim}disposition${t.reset}  ${result.receipt.disposition}`);
  if (result.receipt.outcome_state) lines.push(`  ${t.dim}outcome${t.reset}      ${result.receipt.outcome_state}`);
  if (Array.isArray(result.receipt.steps)) {
    lines.push(`  ${t.dim}steps${t.reset}     ${result.receipt.steps.length}`);
  }
  const errorText = result.execution.errorMessage ?? result.execution.stderr ?? result.execution.stdout;
  if (errorText.trim()) {
    lines.push(`  ${t.dim}${status === "escalated" ? "reason" : "error"}${t.reset}     ${truncateMultiline(errorText, 8)}`);
  }
  lines.push(`  ${t.dim}inspect${t.reset}   runx inspect ${result.receipt.id} --json`);
  lines.push("");
  return lines.join("\n");
}

function writeRunResult(
  io: CliIo,
  env: NodeJS.ProcessEnv,
  result: {
    readonly status: "success" | "failure";
    readonly skill: { readonly name: string };
    readonly execution: { readonly stdout: string; readonly stderr: string; readonly errorMessage?: string };
    readonly receipt: {
      readonly id: string;
      readonly kind: string;
      readonly duration_ms: number;
      readonly disposition?: string;
      readonly outcome_state?: string;
      readonly steps?: readonly unknown[];
    };
  },
): void {
  if (result.status === "success") {
    io.stdout.write(renderRunSuccess(result, io, env));
    return;
  }
  io.stderr.write(renderRunFailure(result, io, env));
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

export function renderListResult(result: RunxListReport, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(process.stdout, env);
  const lines = [""];
  for (const kind of ["tool", "skill", "chain", "packet", "overlay"] as const) {
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
  if (item.kind === "chain") {
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

export function writeLocalSkillResult(
  io: CliIo,
  env: NodeJS.ProcessEnv,
  parsed: ParsedArgs,
  result: RunLocalSkillResult,
): number {
  if (result.status === "needs_resolution") {
    return writeNeedsResolutionResult(io, env, parsed, result);
  }
  if (result.status === "policy_denied") {
    return writePolicyDeniedResult(io, parsed, result);
  }
  if (parsed.json) {
    const status = result.receipt.disposition === "escalated" ? "escalated" : result.status;
    io.stdout.write(
      `${JSON.stringify(
        {
          ...result,
          status,
          execution_status: result.status,
          disposition: result.receipt.disposition ?? "completed",
          outcome_state: result.receipt.outcome_state ?? "complete",
        },
        null,
        2,
      )}\n`,
    );
  } else {
    writeRunResult(io, env, result);
  }
  return result.status === "success" ? 0 : 1;
}

function writeNeedsResolutionResult(
  io: CliIo,
  env: NodeJS.ProcessEnv,
  parsed: ParsedArgs,
  result: Extract<RunLocalSkillResult, { readonly status: "needs_resolution" }>,
): number {
  const productionMode = env.RUNX_PRODUCTION === "1";
  if (parsed.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          status: productionMode ? "failure" : "needs_resolution",
          disposition: productionMode ? "failure_no_resolver" : "needs_resolution",
          execution_status: productionMode ? "failure" : null,
          outcome_state: "pending",
          skill: result.skill.name,
          skill_path: result.skillPath,
          run_id: result.runId,
          step_ids: result.stepIds,
          step_labels: result.stepLabels,
          requests: result.requests,
          ...(productionMode
            ? { failure_reason: "RUNX_PRODUCTION=1 forbids unresolved cognitive-work requests" }
            : {}),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.stdout.write(renderNeedsResolution(result, env));
  }
  if (productionMode) {
    const requestIds = result.requests.map((request) => request.id).join(", ");
    io.stderr.write(
      `runx: production run ${result.runId} halted with unresolved cognitive-work request(s): ${requestIds}\n`
      + "  RUNX_PRODUCTION=1 forbids pausing; supply --answers or unset RUNX_PRODUCTION to allow pause semantics.\n",
    );
  }
  return 2;
}

function writePolicyDeniedResult(
  io: CliIo,
  parsed: ParsedArgs,
  result: Extract<RunLocalSkillResult, { readonly status: "policy_denied" }>,
): number {
  if (parsed.json) {
    const approvalRequired = parsed.nonInteractive && result.approval !== undefined;
    const disposition = approvalRequired ? "approval_required" : (result.receipt?.disposition ?? "policy_denied");
    const executionStatus = approvalRequired ? null : "failure";
    const outcomeState = approvalRequired ? "pending" : (result.receipt?.outcome_state ?? "complete");
    io.stdout.write(
      `${JSON.stringify(
        {
          status: approvalRequired ? "approval_required" : "policy_denied",
          execution_status: executionStatus,
          disposition,
          outcome_state: outcomeState,
          skill: result.skill.name,
          reasons: result.reasons,
          approval: result.approval
            ? {
                gate_id: result.approval.gate.id,
                gate_type: result.approval.gate.type ?? "unspecified",
                reason: result.approval.gate.reason,
                summary: result.approval.gate.summary,
                decision: result.approval.approved ? "approved" : "denied",
              }
            : undefined,
          receipt_id: result.receipt?.id,
        },
        null,
        2,
      )}\n`,
    );
    return approvalRequired ? 2 : 1;
  }
  io.stderr.write(renderPolicyDenied(result.skill.name, result.reasons, result.receipt));
  return 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
