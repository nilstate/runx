import { existsSync } from "node:fs";
import path from "node:path";

import type { ResolutionRequest } from "@runxhq/core/executor";

import { shortId, statusIcon, theme } from "../ui.js";
import { humanizeLabel } from "./internal.js";

interface RunStateSummary {
  readonly skill: { readonly name: string };
  readonly runId: string;
  readonly stepIds?: readonly string[];
  readonly stepLabels?: readonly string[];
}

interface LocalAgentInstall {
  readonly command: string;
  readonly label: string;
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

export function humanizeExpectedOutput(value: string): string {
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
