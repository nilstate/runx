import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveDefaultSkillAdapters } from "@runxhq/adapters";
import { resolvePathFromUserInput } from "@runxhq/core/config";
import { runLocalSkill, type Caller, type RunLocalSkillResult } from "@runxhq/core/runner-local";
import { resolveEnvToolCatalogAdapters } from "@runxhq/core/tool-catalogs";

import { resolveBundledCliVoiceProfilePath } from "../runtime-assets.js";
import type {
  DocsCommandArgs,
  DocsCommandDeps,
  DocsCommandResult,
  ExecutedDocsSkill,
  GitHubHydratedThread,
  GitHubIssueRef,
} from "./docs-shared.js";
import { firstNonEmptyString, readRecord, readStringInput } from "./docs-shared.js";

export async function loadThreadAdapterModule(env: NodeJS.ProcessEnv): Promise<{
  readonly parseGitHubIssueRef: (...values: readonly unknown[]) => GitHubIssueRef;
  readonly fetchGitHubIssueThread: (options: {
    readonly adapterRef: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
  }) => GitHubHydratedThread;
  readonly pushGitHubMessage: (options: {
    readonly thread: GitHubHydratedThread;
    readonly outboxEntry: Readonly<Record<string, unknown>>;
    readonly nextStatus?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly workspacePath?: string;
  }) => Readonly<Record<string, unknown>>;
}> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    firstNonEmptyString(env.RUNX_DOCS_THREAD_ADAPTER_PATH),
    path.resolve(here, "../../tools/thread/github_adapter.mjs"),
    path.resolve(here, "../../../tools/thread/github_adapter.mjs"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    return await import(pathToFileURL(candidate).href);
  }
  throw new Error("Unable to resolve the runx GitHub thread adapter from the CLI package.");
}

export async function executeDocsSkill(
  sourceyRoot: string,
  skillName: "docs-scan" | "docs-build" | "docs-pr" | "docs-outreach" | "docs-signal",
  inputs: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
  caller: Caller,
  parsed: DocsCommandArgs,
  deps: DocsCommandDeps,
): Promise<ExecutedDocsSkill> {
  const skillPath = path.join(sourceyRoot, "skills", skillName);
  if (!existsSync(skillPath)) {
    throw new Error(`Sourcey docs skill '${skillName}' was not found at ${skillPath}.`);
  }
  const adapters = await resolveDefaultSkillAdapters(env);
  const registryStore = await deps.resolveRegistryStoreForChains(env);
  const result = await runLocalSkill({
    skillPath,
    runner: skillName,
    inputs,
    caller,
    env,
    receiptDir: parsed.receiptDir ? resolvePathFromUserInput(parsed.receiptDir, env) : undefined,
    adapters,
    registryStore,
    toolCatalogAdapters: resolveEnvToolCatalogAdapters(env),
    voiceProfilePath: await resolveBundledCliVoiceProfilePath(),
  });
  if (result.status !== "success" && result.status !== "failure") {
    return { result };
  }
  const packet = parseSkillPacket(result.execution.stdout);
  return {
    result,
    packet,
    data: readRecord(packet?.data) ?? packet,
  };
}

export function resolveSourceyRoot(inputs: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv): string {
  const explicit = readStringInput(inputs, ["sourcey-root", "sourcey_root"]);
  const candidate = explicit
    ? resolvePathFromUserInput(explicit, env)
    : resolvePathFromUserInput(env.RUNX_DOCS_ROOT ?? env.RUNX_CWD ?? process.cwd(), env);
  if (!existsSync(path.join(candidate, "skills", "docs-build"))) {
    throw new Error(`Sourcey docs root '${candidate}' does not contain skills/docs-build. Pass --sourcey-root explicitly.`);
  }
  return candidate;
}

export function resolveOptionalSourceyRoot(inputs: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv): string | undefined {
  const explicit = readStringInput(inputs, ["sourcey-root", "sourcey_root"]);
  if (explicit) {
    return resolveSourceyRoot(inputs, env);
  }
  const candidate = resolvePathFromUserInput(env.RUNX_DOCS_ROOT ?? env.RUNX_CWD ?? process.cwd(), env);
  return existsSync(path.join(candidate, "skills", "docs-build")) ? candidate : undefined;
}

export function resolveDocsThreadCwd(inputs: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv): string {
  const explicit = readStringInput(inputs, ["sourcey-root", "sourcey_root"]);
  return explicit
    ? resolvePathFromUserInput(explicit, env)
    : resolvePathFromUserInput(env.RUNX_DOCS_ROOT ?? env.RUNX_CWD ?? process.cwd(), env);
}

export function toDocsSkillFailure(
  action: NonNullable<DocsCommandArgs["docsAction"]>,
  issue: string | undefined,
  phase: "scan" | "build" | "review" | "signal",
  result: RunLocalSkillResult,
): DocsCommandResult {
  if (result.status === "needs_resolution") {
    return {
      status: "needs_resolution",
      action,
      issue,
      phase,
      message: buildNeedsResolutionMessage(phase, result),
      result,
    };
  }
  if (result.status === "policy_denied") {
    return {
      status: "policy_denied",
      action,
      issue,
      phase,
      message: result.reasons.join("; ") || `The ${phase} phase was denied by policy.`,
      result,
    };
  }
  return {
    status: "failure",
    action,
    issue,
    phase,
    message: firstNonEmptyString(result.execution.stderr, result.execution.errorMessage, `The ${phase} phase failed.`) ?? `The ${phase} phase failed.`,
    result,
  };
}

export function normalizeDocsRepoRoot(candidate: string): string {
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: candidate,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return topLevel.length > 0 ? topLevel : candidate;
  } catch {
    return candidate;
  }
}

function parseSkillPacket(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return readRecord(parsed);
  } catch {
    return undefined;
  }
}

function buildNeedsResolutionMessage(
  phase: "scan" | "build" | "review" | "signal",
  result: Extract<RunLocalSkillResult, { readonly status: "needs_resolution" }>,
): string {
  const requests = Array.isArray(result.requests) ? result.requests : [];
  const cognitiveRequest = requests.find((request) => request.kind === "cognitive_work");
  if (!cognitiveRequest) {
    return `The ${phase} phase needs resolution before the docs flow can continue.`;
  }

  const labels = Array.isArray(result.stepLabels) ? result.stepLabels.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  const label = labels[0];
  return label
    ? `The ${phase} phase paused at '${label}' and needs managed agent work. Configure RUNX_AGENT_PROVIDER and RUNX_AGENT_MODEL plus OPENAI_API_KEY or ANTHROPIC_API_KEY, then rerun.`
    : `The ${phase} phase needs managed agent work. Configure RUNX_AGENT_PROVIDER and RUNX_AGENT_MODEL plus OPENAI_API_KEY or ANTHROPIC_API_KEY, then rerun.`;
}
