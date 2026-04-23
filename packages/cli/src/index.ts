#!/usr/bin/env node

export const cliPackage = "@runxhq/cli";

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { pathToFileURL } from "node:url";

import { createDefaultSkillAdapters } from "@runxhq/adapters";
import { readLedgerEntries } from "@runxhq/core/artifacts";
import {
  isRemoteRegistryUrl,
  loadLocalSkillPackage,
  resolvePathFromUserInput,
  resolveRunxGlobalHomeDir,
  resolveRunxHomeDir,
  resolveRunxKnowledgeDir,
  resolveRunxRegistryPath,
  resolveRunxRegistryTarget,
  resolveRunxWorkspaceBase,
  resolveSkillInstallRoot,
} from "@runxhq/core/config";
import { runHarness, runHarnessTarget, validatePublishHarness } from "@runxhq/core/harness";
import {
  parseRunnerManifestYaml,
  parseToolManifestJson,
  validateRunnerManifest,
  validateToolManifest,
} from "@runxhq/core/parser";
import { createFixtureMarketplaceAdapter, type SkillSearchResult } from "@runxhq/core/marketplaces";
import { createFileKnowledgeStore } from "@runxhq/core/knowledge";
import { writeLocalReceipt } from "@runxhq/core/receipts";
import {
  createDefaultHttpCachedRegistryStore,
  createFileRegistryStore,
  createLocalRegistryClient,
  publishSkillMarkdown,
  type RegistryStore,
} from "@runxhq/core/registry";
import {
  installLocalSkill,
  inspectLocalReceipt,
  listLocalHistory,
  runLocalSkill,
  type Caller,
  type ExecutionEvent,
  type LocalReceiptSummary,
  type RunLocalSkillResult,
} from "@runxhq/core/runner-local";
import type { ApprovalGate, Question, ResolutionRequest, ResolutionResponse } from "@runxhq/core/executor";
import { loadCliAgentRuntime, type CliAgentRuntime } from "./agent-runtime.js";
import {
  buildLocalPacketIndex,
  countYamlFiles,
  deepEqual,
  discoverSkillProfilePaths,
  isPlainRecord,
  safeReadDir,
  sha256Stable,
  stableStringify,
  toProjectPath,
  writeJsonFile,
} from "./authoring-utils.js";
import { configAction, flattenConfig, handleConfigCommand, type ConfigResult } from "./commands/config.js";
import { handleInitCommand, type InitResult } from "./commands/init.js";
import {
  handleListCommand,
  normalizeListKind,
  type RunxListItem,
  type RunxListReport,
  type RunxListRequestedKind,
} from "./commands/list.js";
import { handleNewCommand, type NewResult } from "./commands/new.js";
import { createHttpConnectService } from "./connect-http.js";
import { ensureRunxInstallState } from "./runx-state.js";
import {
  preferredRunCommand,
  resolveRunnableSkillReference,
  runSkillSearch,
} from "./skill-refs.js";
export { resolveSkillReference, resolveRunnableSkillReference } from "./skill-refs.js";
import { streamTrainableReceipts } from "./trainable-receipts.js";
import { parse as parseYaml } from "yaml";

export interface CliIo {
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
}

interface UiTheme {
  readonly on: boolean;
  readonly reset: string;
  readonly bold: string;
  readonly dim: string;
  readonly cyan: string;
  readonly magenta: string;
  readonly green: string;
  readonly red: string;
  readonly yellow: string;
  readonly gray: string;
}

function isTtyStream(stream: unknown): boolean {
  return typeof stream === "object" && stream !== null && (stream as { isTTY?: boolean }).isTTY === true;
}

function parseDateFilter(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid date for ${flag}: ${value}`);
  }
  return ms;
}

function theme(stream: NodeJS.WritableStream | undefined = process.stdout, env: NodeJS.ProcessEnv = process.env): UiTheme {
  const on = isTtyStream(stream) && !env.NO_COLOR;
  const code = (seq: string) => (on ? seq : "");
  return {
    on,
    reset: code("\u001b[0m"),
    bold: code("\u001b[1m"),
    dim: code("\u001b[2m"),
    cyan: code("\u001b[38;5;117m"),
    magenta: code("\u001b[38;5;207m"),
    green: code("\u001b[38;5;42m"),
    red: code("\u001b[38;5;203m"),
    yellow: code("\u001b[38;5;221m"),
    gray: code("\u001b[38;5;244m"),
  };
}

function statusIcon(status: string, t: UiTheme): string {
  if (status === "success" || status === "verified" || status === "installed") return `${t.green}✓${t.reset}`;
  if (status === "failure" || status === "invalid" || status === "denied") return `${t.red}✗${t.reset}`;
  if (status === "needs_resolution") return `${t.yellow}◇${t.reset}`;
  if (status === "unverified" || status === "unchanged") return `${t.dim}·${t.reset}`;
  return `${t.dim}·${t.reset}`;
}

function renderRows(rows: readonly (readonly [string, string | undefined])[], t: UiTheme): string[] {
  const visible = rows.filter(([, value]) => value !== undefined && value !== "");
  if (visible.length === 0) return [];
  const width = Math.max(...visible.map(([label]) => label.length));
  return visible.map(([label, value]) => `  ${t.dim}${label.padEnd(width)}${t.reset}  ${value}`);
}

function renderKeyValue(title: string, status: string, rows: readonly (readonly [string, string | undefined])[], t: UiTheme): string {
  const lines = ["", `  ${statusIcon(status, t)}  ${t.bold}${title}${t.reset}  ${t.dim}${status}${t.reset}`];
  lines.push(...renderRows(rows, t));
  lines.push("");
  return lines.join("\n");
}

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

function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay}d ago`;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
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

export interface CliServices {
  readonly connect?: ConnectService;
}

export interface ConnectService {
  readonly list: () => Promise<unknown>;
  readonly preprovision: (request: {
    readonly provider: string;
    readonly scopes: readonly string[];
    readonly scope_family?: string;
    readonly authority_kind?: "read_only" | "constructive" | "destructive";
    readonly target_repo?: string;
    readonly target_locator?: string;
  }) => Promise<unknown>;
  readonly revoke: (grantId: string) => Promise<unknown>;
}

interface CallerInputFile {
  readonly answers: Readonly<Record<string, unknown>>;
  readonly approvals?: boolean | Readonly<Record<string, boolean>>;
}

interface DoctorRepair {
  readonly id: string;
  readonly kind: "create_file" | "replace_file" | "edit_yaml" | "edit_json" | "add_fixture" | "run_command" | "manual";
  readonly confidence: "low" | "medium" | "high";
  readonly risk: "low" | "medium" | "high" | "sensitive";
  readonly path?: string;
  readonly json_pointer?: string;
  readonly contents?: string;
  readonly patch?: string;
  readonly command?: string;
  readonly requires_human_review: boolean;
}

interface DoctorDiagnostic {
  readonly id: string;
  readonly instance_id: string;
  readonly severity: "error" | "warning" | "info";
  readonly title: string;
  readonly message: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly location: {
    readonly path: string;
    readonly json_pointer?: string;
  };
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly repairs: readonly DoctorRepair[];
}

interface DoctorReport {
  readonly schema: "runx.doctor.v1";
  readonly status: "success" | "failure";
  readonly summary: {
    readonly errors: number;
    readonly warnings: number;
    readonly infos: number;
  };
  readonly diagnostics: readonly DoctorDiagnostic[];
}

interface ToolBuildReport {
  readonly schema: "runx.tool.build.v1";
  readonly status: "success" | "failure";
  readonly built: readonly {
    readonly path: string;
    readonly manifest: string;
    readonly source_hash: string;
    readonly schema_hash: string;
  }[];
  readonly errors: readonly string[];
}

interface ToolMigrateReport {
  readonly schema: "runx.tool.migrate.v1";
  readonly status: "success" | "failure";
  readonly migrated: readonly {
    readonly path: string;
    readonly manifest: string;
  }[];
  readonly errors: readonly string[];
}

interface FixtureAssertion {
  readonly path: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly kind: "subset_miss" | "exact_mismatch" | "packet_invalid" | "status_mismatch" | "type_mismatch";
  readonly message: string;
}

interface DevFixtureResult {
  readonly name: string;
  readonly lane: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly status: "success" | "failure" | "skipped";
  readonly duration_ms: number;
  readonly assertions: readonly FixtureAssertion[];
  readonly skip_reason?: string;
  readonly output?: unknown;
  readonly replay_path?: string;
}

interface PreparedFixtureWorkspace {
  readonly root?: string;
  readonly tokens: Readonly<Record<string, string>>;
  readonly cleanup: () => Promise<void>;
}

interface DevReport {
  readonly schema: "runx.dev.v1";
  readonly status: "success" | "failure" | "skipped" | "needs_approval";
  readonly doctor: DoctorReport;
  readonly fixtures: readonly DevFixtureResult[];
  readonly receipt_id?: string;
}

export interface ParsedArgs {
  readonly command?: string;
  readonly subcommand?: string;
  readonly doctorPath?: string;
  readonly doctorFix: boolean;
  readonly doctorExplainId?: string;
  readonly doctorListDiagnostics: boolean;
  readonly toolAction?: "build" | "migrate";
  readonly toolPath?: string;
  readonly toolAll: boolean;
  readonly devPath?: string;
  readonly devLane?: string;
  readonly devRecord: boolean;
  readonly devRealAgents: boolean;
  readonly devWatch: boolean;
  readonly listKind?: RunxListRequestedKind;
  readonly listOkOnly: boolean;
  readonly listInvalidOnly: boolean;
  readonly exportAction?: "trainable";
  readonly skillAction?: "search" | "add" | "publish" | "inspect";
  readonly knowledgeAction?: "show";
  readonly searchQuery?: string;
  readonly skillRef?: string;
  readonly publishPath?: string;
  readonly receiptId?: string;
  readonly resumeReceiptId?: string;
  readonly historyQuery?: string;
  readonly historySkill?: string;
  readonly historyStatus?: string;
  readonly historySource?: string;
  readonly historySince?: string;
  readonly historyUntil?: string;
  readonly skillPath?: string;
  readonly harnessPath?: string;
  readonly evolveObjective?: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly nonInteractive: boolean;
  readonly json: boolean;
  readonly answersPath?: string;
  readonly receiptDir?: string;
  readonly runner?: string;
  readonly knowledgeProject?: string;
  readonly sourceFilter?: string;
  readonly installVersion?: string;
  readonly installTo?: string;
  readonly publishOwner?: string;
  readonly publishVersion?: string;
  readonly registryUrl?: string;
  readonly expectedDigest?: string;
  readonly connectAction?: "list" | "revoke" | "preprovision";
  readonly connectProvider?: string;
  readonly connectGrantId?: string;
  readonly connectScopes: readonly string[];
  readonly connectScopeFamily?: string;
  readonly connectAuthorityKind?: "read_only" | "constructive" | "destructive";
  readonly connectTargetRepo?: string;
  readonly connectTargetLocator?: string;
  readonly configAction?: "set" | "get" | "list";
  readonly configKey?: string;
  readonly configValue?: string;
  readonly newName?: string;
  readonly newDirectory?: string;
  readonly initAction?: "project" | "global";
  readonly prefetchOfficial: boolean;
  readonly exportSince?: string;
  readonly exportUntil?: string;
  readonly exportStatus?: string;
  readonly exportSource?: string;
}

const builtinRootCommands = new Set([
  "doctor",
  "dev",
  "list",
  "tool",
  "skill",
  "evolve",
  "resume",
  "search",
  "add",
  "inspect",
  "history",
  "knowledge",
  "harness",
  "connect",
  "config",
  "new",
  "init",
  "export-receipts",
]);

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  io: CliIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  env: NodeJS.ProcessEnv = process.env,
  services: CliServices = {},
): Promise<number> {
  if (isHelpRequest(argv)) {
    writeUsage(io.stdout, env);
    return 0;
  }

  const parsed = parseArgs(argv);

  if (!isSupportedCommand(parsed)) {
    writeUsage(io.stderr, env);
    return 64;
  }

  try {
    const connectService = parsed.command === "connect" ? services.connect ?? resolveConfiguredConnectService(env) : services.connect;
    const callerInput = parsed.answersPath
      ? await readCallerInputFile(resolvePathFromUserInput(parsed.answersPath, env))
      : { answers: {} };
    const agentRuntimeLoader = createAgentRuntimeLoader(env);
    const caller = parsed.nonInteractive
      ? createNonInteractiveCaller(callerInput.answers, callerInput.approvals, agentRuntimeLoader)
      : createInteractiveCaller(io, callerInput.answers, callerInput.approvals, { reportEvents: !parsed.json }, env, agentRuntimeLoader);
    if (parsed.command === "harness" && parsed.harnessPath) {
      const result = await runHarnessTarget(resolvePathFromUserInput(parsed.harnessPath, env), {
        env,
        registryStore: await resolveRegistryStoreForChains(env),
        adapters: createDefaultSkillAdapters(),
      });
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        io.stdout.write(renderHarnessResult(result));
      }
      for (const error of result.assertionErrors) {
        io.stderr.write(`${error}\n`);
      }
      return result.assertionErrors.length === 0 ? 0 : 1;
    }

    if (parsed.command === "doctor") {
      if (parsed.doctorListDiagnostics) {
        const result = listDoctorDiagnostics();
        if (parsed.json) {
          io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          io.stdout.write(renderDoctorDiagnosticList(result, env));
        }
        return 0;
      }
      if (parsed.doctorExplainId) {
        const result = explainDoctorDiagnostic(parsed.doctorExplainId);
        if (parsed.json) {
          io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          io.stdout.write(renderDoctorDiagnosticExplanation(result, env));
        }
        return result.status === "success" ? 0 : 1;
      }
      const result = await handleDoctorCommand(parsed, env);
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        io.stdout.write(renderDoctorResult(result, env));
      }
      return result.status === "success" ? 0 : 1;
    }

    if (parsed.command === "tool" && parsed.toolAction) {
      const result = parsed.toolAction === "build"
        ? await handleToolBuildCommand(parsed, env)
        : await handleToolMigrateCommand(parsed, env);
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        io.stdout.write(renderToolCommandResult(result, env));
      }
      return result.status === "success" ? 0 : 1;
    }

    if (parsed.command === "dev") {
      const result = await handleDevCommand(parsed, env);
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        io.stdout.write(renderDevResult(result, env));
      }
      return result.status === "success" || result.status === "skipped" ? 0 : 1;
    }

    if (parsed.command === "list" && parsed.listKind) {
      const result = await handleListCommand(parsed, env);
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        io.stdout.write(renderListResult(result, env));
      }
      return result.items.some((item) => item.status === "invalid") && !parsed.listOkOnly ? 1 : 0;
    }

    if (parsed.command === "connect" && parsed.connectAction) {
      if (!connectService) {
        throw new Error(
          "runx connect requires the hosted Connect service. Set RUNX_CONNECT_BASE_URL=https://connect.runx.ai and RUNX_CONNECT_ACCESS_TOKEN, or configure an equivalent hosted connect base URL.",
        );
      }
      const result =
        parsed.connectAction === "list"
          ? await connectService.list()
          : parsed.connectAction === "revoke" && parsed.connectGrantId
            ? await connectService.revoke(parsed.connectGrantId)
            : parsed.connectAction === "preprovision" && parsed.connectProvider
              ? await connectService.preprovision({
                provider: parsed.connectProvider,
                scopes: parsed.connectScopes,
                scope_family: parsed.connectScopeFamily,
                authority_kind: parsed.connectAuthorityKind,
                target_repo: parsed.connectTargetRepo,
                target_locator: parsed.connectTargetLocator,
              })
              : undefined;

      if (!result) {
        throw new Error("Invalid runx connect invocation.");
      }
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify({ status: "success", connect: result }, null, 2)}\n`);
      } else {
        io.stdout.write(renderConnectResult(parsed.connectAction, result, env));
      }
      return 0;
    }

    if (parsed.command === "config" && parsed.configAction) {
      const result = await handleConfigCommand(parsed, env);
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify({ status: "success", config: result }, null, 2)}\n`);
      } else {
        io.stdout.write(renderConfigResult(result, env));
      }
      return 0;
    }

    if (parsed.command === "init" && parsed.initAction) {
      const result = await handleInitCommand(parsed, env);
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify({ status: "success", init: result }, null, 2)}\n`);
      } else {
        io.stdout.write(renderInitResult(result, env));
      }
      return 0;
    }

    if (parsed.command === "new" && parsed.newName) {
      const result = await handleNewCommand(parsed, env);
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify({ status: "success", new: result }, null, 2)}\n`);
      } else {
        io.stdout.write(renderNewResult(result, env));
      }
      return 0;
    }

    if ((parsed.command === "skill" || parsed.command === "search") && parsed.skillAction === "search" && parsed.searchQuery) {
      const results = await runSkillSearch(parsed.searchQuery, parsed.sourceFilter, env, parsed.registryUrl);
      if (parsed.json) {
        io.stdout.write(
          `${JSON.stringify(
            {
              status: "success",
              query: parsed.searchQuery,
              source: parsed.sourceFilter ?? "all",
              results,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        io.stdout.write(renderSearchResults(results, env));
      }
      return 0;
    }

    if ((parsed.command === "skill" || parsed.command === "add") && parsed.skillAction === "add" && parsed.skillRef) {
      const registryTarget = resolveRunxRegistryTarget(env, { registry: parsed.registryUrl });
      const installState = registryTarget.mode === "remote"
        ? await ensureRunxInstallState(resolveRunxGlobalHomeDir(env))
        : undefined;
      const result = await installLocalSkill({
        ref: parsed.skillRef,
        registryStore: registryTarget.mode === "local"
          ? createFileRegistryStore(registryTarget.registryPath)
          : undefined,
        marketplaceAdapters: env.RUNX_ENABLE_FIXTURE_MARKETPLACE === "1" ? [createFixtureMarketplaceAdapter()] : [],
        destinationRoot: resolveSkillInstallRoot(env, parsed.installTo),
        version: parsed.installVersion,
        expectedDigest: parsed.expectedDigest,
        registryUrl: registryTarget.mode === "remote" ? registryTarget.registryUrl : parsed.registryUrl,
        installationId: installState?.state.installation_id,
      });
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify({ status: "success", install: result }, null, 2)}\n`);
      } else {
        io.stdout.write(renderInstallResult(result, env));
      }
      return 0;
    }

    if (parsed.command === "skill" && parsed.skillAction === "publish" && parsed.publishPath) {
      if (isRemoteRegistryUrl(parsed.registryUrl)) {
        throw new Error("Remote registry publish is not supported from the OSS CLI. Use a local registry store or the hosted admin surface.");
      }
      const resolvedPublishPath = resolvePathFromUserInput(parsed.publishPath, env);
      const harness = await validatePublishHarness(resolvedPublishPath, {
        env,
        registryStore: await resolveRegistryStoreForChains(env),
        adapters: createDefaultSkillAdapters(),
      });
      if (harness.status === "failed") {
        throw new Error(`Harness failed for ${resolvedPublishPath}: ${harness.assertion_errors.join("; ")}`);
      }
      const skillPackage = await loadLocalSkillPackage(resolvedPublishPath);
      const result = await publishSkillMarkdown(
        createLocalRegistryClient(createFileRegistryStore(resolveRunxRegistryPath(env, { registry: parsed.registryUrl }))),
        skillPackage.markdown,
        {
          owner: parsed.publishOwner,
          version: parsed.publishVersion,
          registryUrl: parsed.registryUrl,
          profileDocument: skillPackage.profileDocument,
        },
      );
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify({ status: "success", publish: { ...result, harness } }, null, 2)}\n`);
      } else {
        io.stdout.write(renderPublishResult({ ...result, harness }, env));
      }
      return 0;
    }

    if ((parsed.command === "skill" || parsed.command === "inspect") && parsed.skillAction === "inspect" && parsed.receiptId) {
      const inspection = await inspectLocalReceipt({
        receiptId: parsed.receiptId,
        receiptDir: parsed.receiptDir ? resolvePathFromUserInput(parsed.receiptDir, env) : undefined,
        env,
      });
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
      } else {
        io.stdout.write(renderReceiptInspection(inspection.summary, env));
      }
      return 0;
    }

    if (parsed.command === "history") {
      const sinceMs = parseDateFilter(parsed.historySince, "--since");
      const untilMs = parseDateFilter(parsed.historyUntil, "--until");
      const history = await listLocalHistory({
        receiptDir: parsed.receiptDir ? resolvePathFromUserInput(parsed.receiptDir, env) : undefined,
        env,
        query: parsed.historyQuery,
        skill: parsed.historySkill,
        status: parsed.historyStatus,
        sourceType: parsed.historySource,
        sinceMs,
        untilMs,
      });
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify({ status: "success", query: parsed.historyQuery, ...history }, null, 2)}\n`);
      } else {
        io.stdout.write(renderHistory(history.receipts, env, parsed.historyQuery));
      }
      return 0;
    }

    if (parsed.command === "export-receipts" && parsed.exportAction === "trainable") {
      const receiptDir = parsed.receiptDir
        ? resolvePathFromUserInput(parsed.receiptDir, env)
        : path.resolve(env.RUNX_RECEIPT_DIR ?? env.INIT_CWD ?? process.cwd(), ".runx", "receipts");
      for await (const record of streamTrainableReceipts({
        receiptDir,
        runxHome: env.RUNX_HOME,
        since: parsed.exportSince,
        until: parsed.exportUntil,
        status: parsed.exportStatus,
        source: parsed.exportSource,
      })) {
        io.stdout.write(`${JSON.stringify(record)}\n`);
      }
      return 0;
    }

    if (parsed.command === "knowledge" && parsed.knowledgeAction === "show") {
      const project = resolvePathFromUserInput(parsed.knowledgeProject ?? ".", env);
      const projections = await createFileKnowledgeStore(resolveKnowledgeDir(env)).listProjections({ project });
      const report = {
        status: "success",
        project,
        projections,
      };
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        io.stdout.write(renderKnowledgeProjections(project, projections, env));
      }
      return 0;
    }

    if (parsed.command === "evolve") {
      const evolveInputs: Record<string, unknown> = { ...parsed.inputs };
      if (parsed.evolveObjective !== undefined) {
        evolveInputs.objective = parsed.evolveObjective;
      }
      const result = await executeLocalSkillCommand({
        skillPath: await resolveRunnableSkillReference("evolve", env),
        inputs: evolveInputs,
        parsed: {
          ...parsed,
          runner: parsed.runner ?? (parsed.evolveObjective === undefined && !parsed.resumeReceiptId ? "introspect" : undefined),
        },
        caller,
        env,
      });
      return writeLocalSkillResult(io, env, parsed, result);
    }

    if (parsed.command === "resume" && parsed.resumeReceiptId) {
      const result = await executeLocalSkillCommand({
        skillPath: await resolveResumeSkillPath(parsed.resumeReceiptId, parsed.receiptDir, env),
        inputs: parsed.inputs,
        parsed,
        caller,
        env,
      });
      return writeLocalSkillResult(io, env, parsed, result);
    }

    const result = await executeLocalSkillCommand({
      skillPath: await resolveRunnableSkillReference(parsed.skillPath ?? "", env),
      inputs: parsed.inputs,
      parsed,
      caller,
      env,
    });
    return writeLocalSkillResult(io, env, parsed, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(renderCliError(message));
    return 1;
  }
}

async function resolveRegistryStoreForChains(env: NodeJS.ProcessEnv): Promise<RegistryStore | undefined> {
  const target = resolveRunxRegistryTarget(env);
  if (target.mode === "local") {
    return createFileRegistryStore(target.registryPath);
  }
  if (!target.registryUrl) {
    return undefined;
  }
  const globalHomeDir = resolveRunxGlobalHomeDir(env);
  const install = await ensureRunxInstallState(globalHomeDir);
  return createDefaultHttpCachedRegistryStore({
    remoteBaseUrl: target.registryUrl,
    cacheRoot: resolveRunxRegistryPath(env),
    installationId: install.state.installation_id,
    channel: "cli-chain",
  });
}

async function executeLocalSkillCommand(options: {
  readonly skillPath: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly parsed: ParsedArgs;
  readonly caller: Caller;
  readonly env: NodeJS.ProcessEnv;
}): Promise<RunLocalSkillResult> {
  return await runLocalSkill({
    skillPath: options.skillPath,
    inputs: options.inputs,
    answersPath: options.parsed.answersPath ? resolvePathFromUserInput(options.parsed.answersPath, options.env) : undefined,
    caller: options.caller,
    env: options.env,
    receiptDir: options.parsed.receiptDir ? resolvePathFromUserInput(options.parsed.receiptDir, options.env) : undefined,
    runner: options.parsed.runner,
    resumeFromRunId: options.parsed.resumeReceiptId,
    registryStore: await resolveRegistryStoreForChains(options.env),
    adapters: createDefaultSkillAdapters(),
  });
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
    const requestIds = result.requests.map((r) => r.id).join(", ");
    io.stderr.write(
      `runx: production run ${result.runId} halted with unresolved cognitive-work request(s): ${requestIds}\n` +
      `  RUNX_PRODUCTION=1 forbids pausing; supply --answers or unset RUNX_PRODUCTION to allow pause semantics.\n`,
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

function writeLocalSkillResult(
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
    io.stdout.write(
      `${JSON.stringify(
        {
          ...result,
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

function isHelpRequest(argv: readonly string[]): boolean {
  return argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h");
}

const BANNER_LINES = [
  "_______ __ __  ____ ___  ___",
  "\\_  __ \\  |  \\/    \\\\  \\/  /",
  " |  | \\/  |  /   |  \\>    < ",
  " |__|  |____/|___|  /__/\\_ \\",
  "                  \\/      \\/",
];

function writeBanner(stream: NodeJS.WritableStream, env: NodeJS.ProcessEnv): void {
  const t = theme(stream, env);
  const gradient = t.on
    ? ["\u001b[38;5;201m", "\u001b[38;5;207m", "\u001b[38;5;177m", "\u001b[38;5;147m", "\u001b[38;5;117m"]
    : ["", "", "", "", ""];
  const lines: string[] = [""];
  for (let i = 0; i < BANNER_LINES.length; i += 1) {
    lines.push(`  ${gradient[i]}${t.bold}${BANNER_LINES[i]}${t.reset}`);
  }
  lines.push("");
  stream.write(`${lines.join("\n")}\n`);
}

function writeUsage(stream: NodeJS.WritableStream, env: NodeJS.ProcessEnv = process.env): void {
  const t = theme(stream, env);
  const wantsBanner = t.on || env.RUNX_BANNER === "1";
  if (wantsBanner) {
    writeBanner(stream, env);
  }
  stream.write(
    [
      "Usage:",
      "  runx <skill> [--runner runner-name] [--input value] [--non-interactive] [--json] [--answers answers.json]",
      "  runx ./skill-dir|./SKILL.md [--runner runner-name] [--input value] [--non-interactive] [--json] [--answers answers.json]",
      "  runx evolve [objective] [--receipt run-id] [--non-interactive] [--json] [--answers answers.json]",
      "  runx resume <run-id> [--non-interactive] [--json] [--answers answers.json]",
      "  runx search <query> [--source registry|marketplace|fixture-marketplace] [--json]",
      "  runx add <ref> [--version version] [--to skills-dir] [--registry url] [--digest sha256] [--json]",
      "  runx inspect <receipt-id> [--receipt-dir dir] [--json]",
      "  runx history [query] [--skill s] [--status s] [--source s] [--since iso] [--until iso] [--receipt-dir dir] [--json]",
      "  runx export-receipts --trainable [--receipt-dir dir] [--since iso] [--until iso] [--status pending|complete|expired] [--source source-type]",
      "  runx knowledge show --project . [--json]",
      "  runx connect list|revoke <grant-id>|<provider> [--scope scope] [--scope-family family] [--authority-kind read_only|constructive|destructive] [--target-repo owner/repo] [--target-locator locator] [--json]",
      "  runx config set|get|list [agent.provider|agent.model|agent.api_key] [value] [--json]",
      "  runx new <name> [--directory dir] [--json]",
      "  runx init [-g|--global] [--prefetch official] [--json]",
      "  runx harness <fixture.yaml|skill-dir|SKILL.md> [--json]",
      "  runx list [tools|skills|chains|packets|overlays] [--ok-only|--invalid-only] [--json]",
      "  runx doctor [path] [--fix] [--explain id|--list-diagnostics] [--json]",
      "  runx dev [path] [--lane deterministic|agent|repo-integration|all] [--record] [--json]",
      "  runx tool build|migrate <tool-dir>|--all [--json]",
      "",
      "Core Flow:",
      "  runx search docs",
      "  runx <skill> --project .",
      "  runx evolve",
      "  runx new docs-demo",
      "  runx init",
      "  runx init -g --prefetch official",
      "  runx resume <run-id>",
      "  runx inspect <receipt-id>",
      "  runx list",
      "  runx doctor",
      "  runx dev",
      "",
      "Manage Skills:",
      "  runx skill search <query>",
      "  runx skill add <ref>",
      "  runx skill publish <skill-dir|SKILL.md> [--owner owner] [--version version] [--registry url-or-path] [--json]",
      "  runx skill inspect <receipt-id> [--receipt-dir dir] [--json]",
      "  runx skill <skill-dir|SKILL.md>",
      "",
    ].join("\n"),
  );
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const inputs: Record<string, unknown> = {};
  let nonInteractive = false;
  let json = false;
  let answersPath: string | undefined;
  let receiptDir: string | undefined;
  let resumeReceiptId: string | undefined;
  let runner: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === "-g") {
      inputs.global = true;
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const knownKey = normalizeKnownFlag(rawKey);

    if (knownKey === "nonInteractive") {
      nonInteractive = true;
      continue;
    }

    if (knownKey === "json") {
      json = true;
      continue;
    }

    const next = nextValue(rest, index);
    const value = inlineValue ?? next;
    if (inlineValue === undefined && next !== "true") {
      index += 1;
    }

    if (knownKey === "answers") {
      answersPath = String(value);
      continue;
    }

    if (knownKey === "receiptDir") {
      receiptDir = String(value);
      continue;
    }

    if (knownKey === "receipt") {
      resumeReceiptId = String(value);
      continue;
    }

    if (knownKey === "runner") {
      runner = String(value);
      continue;
    }

    inputs[rawKey] = mergeInputValue(inputs[rawKey], value);
  }

  const adminOffset = command === "skill" ? 1 : 0;
  const isSkillSearch = (command === "skill" && positionals[0] === "search") || command === "search";
  const isSkillAdd = (command === "skill" && positionals[0] === "add") || command === "add";
  const isSkillPublish = command === "skill" && positionals[0] === "publish";
  const isSkillInspect = (command === "skill" && positionals[0] === "inspect") || command === "inspect";
  const isKnowledgeShow = command === "knowledge" && positionals[0] === "show";
  const isConnect = command === "connect";
  const isConfig = command === "config";
  const isNew = command === "new";
  const isInit = command === "init";
  const isResume = command === "resume";
  const isDoctor = command === "doctor";
  const isTool = command === "tool";
  const isDev = command === "dev";
  const isList = command === "list";
  const isExportReceipts = command === "export-receipts";
  const isTopLevelSkillInvoke = Boolean(command) && !builtinRootCommands.has(command);
  const searchPositionals = positionals.slice(adminOffset);
  const addPositionals = positionals.slice(adminOffset);
  const inspectPositionals = positionals.slice(adminOffset);
  const knowledgeProject = isKnowledgeShow && typeof inputs.project === "string" ? inputs.project : undefined;
  const sourceFilter = isSkillSearch && typeof inputs.source === "string" ? inputs.source : undefined;
  const installVersion = isSkillAdd && typeof inputs.version === "string" ? inputs.version : undefined;
  const installTo = isSkillAdd && typeof inputs.to === "string" ? inputs.to : undefined;
  const publishOwner = isSkillPublish && typeof inputs.owner === "string" ? inputs.owner : undefined;
  const publishVersion = isSkillPublish && typeof inputs.version === "string" ? inputs.version : undefined;
  const registryUrl = (isSkillSearch || isSkillAdd || isSkillPublish) && typeof inputs.registry === "string" ? inputs.registry : undefined;
  const expectedDigest = isSkillAdd && typeof inputs.digest === "string" ? normalizeDigest(inputs.digest) : undefined;
  const connectScopes = isConnect ? normalizeScopes(inputs.scope) : [];
  const connectScopeFamily = isConnect && typeof inputs.scopeFamily === "string"
    ? inputs.scopeFamily
    : isConnect && typeof inputs.scope_family === "string"
      ? inputs.scope_family
      : isConnect && typeof inputs["scope-family"] === "string"
        ? inputs["scope-family"]
      : undefined;
  const connectTargetRepo = isConnect && typeof inputs.targetRepo === "string"
    ? inputs.targetRepo
    : isConnect && typeof inputs.target_repo === "string"
      ? inputs.target_repo
      : isConnect && typeof inputs["target-repo"] === "string"
        ? inputs["target-repo"]
      : undefined;
  const connectTargetLocator = isConnect && typeof inputs.targetLocator === "string"
    ? inputs.targetLocator
    : isConnect && typeof inputs.target_locator === "string"
      ? inputs.target_locator
      : isConnect && typeof inputs["target-locator"] === "string"
        ? inputs["target-locator"]
      : undefined;
  const connectAuthoritySource = inputs.authorityKind ?? inputs.authority_kind ?? inputs["authority-kind"];
  const connectAuthorityKind = isConnect ? normalizeAuthorityKind(connectAuthoritySource) : undefined;
  const newDirectory = isNew && typeof inputs.directory === "string"
    ? inputs.directory
    : isNew && typeof inputs.dir === "string"
      ? inputs.dir
      : isNew
        ? positionals[1]
      : undefined;
  const initAction = isInit && truthyFlag(inputs.global) ? "global" : isInit ? "project" : undefined;
  const prefetchOfficial =
    isInit
    && (inputs.prefetch === "official" || truthyFlag(inputs.prefetch) || truthyFlag(inputs.prefetchOfficial));
  const effectiveInputs = isSkillSearch
    ? omitInputs(inputs, ["source", "registry"])
    : isSkillAdd
      ? omitInputs(inputs, ["version", "to", "registry", "digest"])
      : isSkillPublish
        ? omitInputs(inputs, ["version", "owner", "registry"])
        : isConnect
          ? omitInputs(
            inputs,
            [
              "scope",
              "scopeFamily",
              "scope_family",
              "scope-family",
              "authorityKind",
              "authority_kind",
              "authority-kind",
              "targetRepo",
              "target_repo",
              "target-repo",
              "targetLocator",
              "target_locator",
              "target-locator",
            ],
          )
          : isConfig
            ? {}
            : isNew
              ? omitInputs(inputs, ["directory", "dir"])
            : isInit
              ? omitInputs(inputs, ["global", "prefetch", "prefetchOfficial"])
              : isDoctor
                ? omitInputs(inputs, ["fix", "explain", "listDiagnostics", "list-diagnostics"])
              : isTool
                ? omitInputs(inputs, ["all"])
              : isDev
                ? omitInputs(inputs, ["lane", "record", "realAgents", "real-agents", "watch"])
              : isList
                ? omitInputs(inputs, ["okOnly", "ok-only", "invalidOnly", "invalid-only"])
              : isExportReceipts
                ? omitInputs(inputs, ["trainable", "since", "until", "status", "source"])
              : inputs;

  return {
    command,
    subcommand: positionals[0],
    doctorPath: isDoctor ? positionals[0] : undefined,
    doctorFix: isDoctor && truthyFlag(inputs.fix),
    doctorExplainId: isDoctor && typeof inputs.explain === "string" && inputs.explain !== "true" ? inputs.explain : undefined,
    doctorListDiagnostics: isDoctor && truthyFlag(inputs.listDiagnostics ?? inputs["list-diagnostics"]),
    toolAction: isTool && (positionals[0] === "build" || positionals[0] === "migrate") ? positionals[0] : undefined,
    toolPath: isTool ? positionals[1] : undefined,
    toolAll: isTool && truthyFlag(inputs.all),
    devPath: isDev ? positionals[0] : undefined,
    devLane: isDev && typeof inputs.lane === "string" ? inputs.lane : undefined,
    devRecord: isDev && truthyFlag(inputs.record),
    devRealAgents: isDev && truthyFlag(inputs.realAgents ?? inputs["real-agents"]) || isDev && truthyFlag(inputs.record),
    devWatch: isDev && truthyFlag(inputs.watch),
    listKind: isList ? normalizeListKind(positionals[0]) : undefined,
    listOkOnly: isList && truthyFlag(inputs.okOnly ?? inputs["ok-only"]),
    listInvalidOnly: isList && truthyFlag(inputs.invalidOnly ?? inputs["invalid-only"]),
    exportAction: isExportReceipts && truthyFlag(inputs.trainable) ? "trainable" : undefined,
    skillAction: isSkillSearch ? "search" : isSkillAdd ? "add" : isSkillPublish ? "publish" : isSkillInspect ? "inspect" : undefined,
    knowledgeAction: isKnowledgeShow ? "show" : undefined,
    searchQuery: isSkillSearch ? searchPositionals.join(" ") || undefined : undefined,
    skillRef: isSkillAdd ? addPositionals.join(" ") || undefined : undefined,
    publishPath: isSkillPublish ? positionals[1] : undefined,
    receiptId: isSkillInspect ? inspectPositionals[0] : undefined,
    historyQuery: command === "history" ? positionals.join(" ") || undefined : undefined,
    historySkill: command === "history" && typeof inputs.skill === "string" ? inputs.skill : undefined,
    historyStatus: command === "history" && typeof inputs.status === "string" ? inputs.status : undefined,
    historySource: command === "history" && typeof inputs.source === "string" ? inputs.source : undefined,
    historySince: command === "history" && typeof inputs.since === "string" ? inputs.since : undefined,
    historyUntil: command === "history" && typeof inputs.until === "string" ? inputs.until : undefined,
    skillPath:
      isTopLevelSkillInvoke
        ? command
        : command === "skill" && !isSkillSearch && !isSkillAdd && !isSkillPublish && !isSkillInspect
          ? positionals[0]
          : undefined,
    harnessPath: command === "harness" ? positionals[0] : undefined,
    evolveObjective: command === "evolve" ? positionals.join(" ") || undefined : undefined,
    inputs: effectiveInputs,
    nonInteractive,
    json,
    answersPath,
    receiptDir,
    resumeReceiptId: isResume ? positionals[0] ?? resumeReceiptId : resumeReceiptId,
    runner,
    knowledgeProject,
    sourceFilter,
    installVersion,
    installTo,
    publishOwner,
    publishVersion,
    registryUrl,
    expectedDigest,
    connectAction: isConnect ? connectAction(positionals) : undefined,
    connectProvider: isConnect && positionals[0] !== "list" && positionals[0] !== "revoke" ? positionals[0] : undefined,
    connectGrantId: isConnect && positionals[0] === "revoke" ? positionals[1] : undefined,
    connectScopes,
    connectScopeFamily,
    connectAuthorityKind,
    connectTargetRepo,
    connectTargetLocator,
    configAction: isConfig ? configAction(positionals) : undefined,
    configKey: isConfig ? positionals[1] : undefined,
    configValue: isConfig ? positionals.slice(2).join(" ") || undefined : undefined,
    newName: isNew ? positionals[0] : undefined,
    newDirectory,
    initAction,
    prefetchOfficial,
    exportSince: isExportReceipts && typeof inputs.since === "string" ? inputs.since : undefined,
    exportUntil: isExportReceipts && typeof inputs.until === "string" ? inputs.until : undefined,
    exportStatus: isExportReceipts && typeof inputs.status === "string" ? inputs.status : undefined,
    exportSource: isExportReceipts && typeof inputs.source === "string" ? inputs.source : undefined,
  };
}

function isSupportedCommand(parsed: ParsedArgs): boolean {
  if (parsed.command === "doctor") {
    return true;
  }
  if (parsed.command === "tool" && parsed.toolAction && (parsed.toolAll || parsed.toolPath)) {
    return true;
  }
  if (parsed.command === "dev") {
    return true;
  }
  if (parsed.command === "list" && parsed.listKind) {
    return true;
  }
  if ((parsed.command === "skill" || parsed.command === "search") && parsed.skillAction === "search" && parsed.searchQuery) {
    return true;
  }
  if ((parsed.command === "skill" || parsed.command === "add") && parsed.skillAction === "add" && parsed.skillRef) {
    return true;
  }
  if (parsed.command === "skill" && parsed.skillAction === "publish" && parsed.publishPath) {
    return true;
  }
  if ((parsed.command === "skill" || parsed.command === "inspect") && parsed.skillAction === "inspect" && parsed.receiptId) {
    return true;
  }
  if (parsed.skillPath) {
    return true;
  }
  if (parsed.command === "evolve") {
    return true;
  }
  if (parsed.command === "resume" && parsed.resumeReceiptId) {
    return true;
  }
  if (parsed.command === "history") {
    return true;
  }
  if (parsed.command === "knowledge" && parsed.knowledgeAction === "show") {
    return true;
  }
  if (parsed.command === "harness" && parsed.harnessPath) {
    return true;
  }
  if (parsed.command === "connect" && parsed.connectAction === "list") {
    return true;
  }
  if (parsed.command === "connect" && parsed.connectAction === "revoke" && parsed.connectGrantId) {
    return true;
  }
  if (parsed.command === "connect" && parsed.connectAction === "preprovision" && parsed.connectProvider) {
    return true;
  }
  if (parsed.command === "config" && parsed.configAction === "list") {
    return true;
  }
  if (parsed.command === "config" && parsed.configAction === "get" && parsed.configKey) {
    return true;
  }
  if (parsed.command === "config" && parsed.configAction === "set" && parsed.configKey && parsed.configValue !== undefined) {
    return true;
  }
  if (parsed.command === "new" && parsed.newName) {
    return true;
  }
  if (parsed.command === "init" && parsed.initAction) {
    return true;
  }
  if (parsed.command === "export-receipts" && parsed.exportAction === "trainable") {
    return true;
  }
  return false;
}

function nextValue(args: readonly string[], index: number): string {
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) {
    return "true";
  }
  return next;
}

function omitInput(inputs: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
  const { [key]: _omitted, ...rest } = inputs;
  return rest;
}

function omitInputs(inputs: Readonly<Record<string, unknown>>, keys: readonly string[]): Readonly<Record<string, unknown>> {
  let rest = inputs;
  for (const key of keys) {
    rest = omitInput(rest, key);
  }
  return rest;
}

function mergeInputValue(existing: unknown, next: unknown): unknown {
  if (existing === undefined) {
    return next;
  }
  return Array.isArray(existing) ? [...existing, next] : [existing, next];
}

function truthyFlag(value: unknown): boolean {
  return value === true || value === "true";
}

interface RunStateSummary {
  readonly skill: { readonly name: string };
  readonly runId: string;
  readonly stepIds?: readonly string[];
  readonly stepLabels?: readonly string[];
}

function renderNeedsResolution(
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
    lines.push(
      `  ${t.dim}Detected here:${t.reset} ${localAgents.map((agent) => agent.label).join(", ")}`,
    );
    lines.push(
      `  ${t.dim}Best path:${t.reset} open this repo in ${localAgents.map((agent) => agent.label).join(" or ")} and run ${t.cyan}runx resume ${result.runId}${t.reset}${t.dim} there.${t.reset}`,
    );
  } else if (kinds.includes("cognitive_work")) {
    lines.push(
      `  ${t.dim}Best path:${t.reset} run ${t.cyan}runx resume ${result.runId}${t.reset}${t.dim} from Codex or Claude Code, or script the step with ${t.cyan}--answers${t.reset}${t.dim}.${t.reset}`,
    );
  } else if (kinds.includes("approval")) {
    lines.push(`  ${t.dim}Best path:${t.reset} run ${t.cyan}runx resume ${result.runId}${t.reset}${t.dim} to approve, or pass ${t.cyan}--answers${t.reset}${t.dim} with approval decisions.${t.reset}`);
  } else if (kinds.includes("input")) {
    lines.push(`  ${t.dim}Best path:${t.reset} run ${t.cyan}runx resume ${result.runId}${t.reset}${t.dim} to continue, or pass ${t.cyan}--input${t.reset}${t.dim} values.${t.reset}`);
  }
  lines.push("");
  lines.push(
    `  ${t.dim}Machine mode:${t.reset} ${t.dim}${t.cyan}--json${t.reset}${t.dim} prints the exact request envelope.${t.reset}`,
  );
  lines.push("");
  return lines.join("\n");
}

function renderPolicyDenied(
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

function renderExecutionEvent(event: ExecutionEvent, io: CliIo, env: NodeJS.ProcessEnv): string | undefined {
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
  if (event.type === "resolution_requested") {
    return undefined;
  }
  if (event.type === "resolution_resolved") {
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
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed.includes("\n") ? [] : [["output", trimmed]];
  }
  if (!isRecord(parsed)) return [];
  const fields: Array<[string, string]> = [];
  const push = (key: string, label = key) => {
    const value = parsed[key];
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
  for (const [label, value] of extractOutputHighlights(result.execution.stdout)) {
    lines.push(`  ${t.dim}${label}${t.reset}  ${value}`);
  }
  if (extractOutputHighlights(result.execution.stdout).length === 0 && result.execution.stdout.trim()) {
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
  const lines = [
    "",
    `  ${statusIcon("failure", t)}  ${t.bold}${result.skill.name}${t.reset}  ${t.dim}failure${t.reset}`,
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
    lines.push(`  ${t.dim}error${t.reset}     ${truncateMultiline(errorText, 8)}`);
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

function renderCliError(message: string): string {
  const t = theme(process.stderr);
  const icon = statusIcon("failure", t);
  let hint = "";
  if (/ENOENT.*SKILL\.md/i.test(message) && !/Try/.test(message)) {
    hint = `\n  ${t.dim}Pass a skill name or directory path.${t.reset}`;
  }
  return `\n  ${icon}  ${message}${hint}\n\n`;
}

function renderHarnessResult(
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
      lines.push(
        `  ${statusIcon(entry.status, t)}  ${entry.fixture.name}  ${t.dim}${entry.assertionErrors.length} error(s)${t.reset}`,
      );
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

async function handleToolBuildCommand(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<ToolBuildReport> {
  const root = resolveRunxWorkspaceBase(env);
  const toolDirs = parsed.toolAll
    ? await discoverToolDirectories(root)
    : [resolvePathFromUserInput(parsed.toolPath ?? "", env)];
  const built: {
    readonly path: string;
    readonly manifest: string;
    readonly source_hash: string;
    readonly schema_hash: string;
  }[] = [];
  const errors: string[] = [];
  for (const toolDir of toolDirs) {
    try {
      const result = await buildToolManifest(root, toolDir);
      built.push(result);
    } catch (error) {
      errors.push(`${toProjectPath(root, toolDir)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    schema: "runx.tool.build.v1",
    status: errors.length > 0 ? "failure" : "success",
    built,
    errors,
  };
}

async function handleToolMigrateCommand(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<ToolMigrateReport> {
  const root = resolveRunxWorkspaceBase(env);
  const toolDirs = parsed.toolAll
    ? await discoverLegacyToolDirectories(root)
    : [resolvePathFromUserInput(parsed.toolPath ?? "", env)];
  const migrated: {
    readonly path: string;
    readonly manifest: string;
  }[] = [];
  const errors: string[] = [];
  for (const toolDir of toolDirs) {
    try {
      const yamlPath = path.join(toolDir, "tool.yaml");
      const manifestPath = path.join(toolDir, "manifest.json");
      const raw = parseYaml(await readFile(yamlPath, "utf8")) as unknown;
      if (!isPlainRecord(raw)) {
        throw new Error("tool.yaml must parse to an object.");
      }
      await writeJsonFile(manifestPath, raw);
      await rm(yamlPath, { force: true });
      await buildToolManifest(root, toolDir);
      migrated.push({
        path: toProjectPath(root, toolDir),
        manifest: toProjectPath(root, manifestPath),
      });
    } catch (error) {
      errors.push(`${toProjectPath(root, toolDir)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    schema: "runx.tool.migrate.v1",
    status: errors.length > 0 ? "failure" : "success",
    migrated,
    errors,
  };
}

async function buildToolManifest(root: string, toolDir: string): Promise<ToolBuildReport["built"][number]> {
  const manifestPath = path.join(toolDir, "manifest.json");
  const authored = await loadAuthoredToolDefinition(toolDir);
  if (!existsSync(manifestPath) && !authored) {
    throw new Error("missing manifest.json");
  }
  const raw = authored ?? JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (!isPlainRecord(raw)) {
    throw new Error("manifest.json must be an object.");
  }
  if (authored) {
    await writeAuthoredToolShim(toolDir);
  }
  const sourceHash = await hashToolSource(toolDir);
  const output = isPlainRecord(raw.output)
    ? raw.output
    : normalizeToolOutput(raw);
  const schemaHash = sha256Stable({
    inputs: raw.inputs,
    output,
    artifacts: isPlainRecord(raw.runx) ? raw.runx.artifacts : undefined,
  });
  const normalized = {
    schema: "runx.tool.manifest.v1",
    ...raw,
    runtime: isPlainRecord(raw.runtime)
      ? raw.runtime
      : {
          command: isPlainRecord(raw.source) ? raw.source.command ?? "node" : "node",
          args: isPlainRecord(raw.source) ? raw.source.args ?? ["./run.mjs"] : ["./run.mjs"],
        },
    output,
    source_hash: sourceHash,
    schema_hash: schemaHash,
    toolkit_version: "0.0.0",
  };
  validateToolManifest(parseToolManifestJson(JSON.stringify(normalized)));
  await writeJsonFile(manifestPath, normalized);
  return {
    path: toProjectPath(root, toolDir),
    manifest: toProjectPath(root, manifestPath),
    source_hash: sourceHash,
    schema_hash: schemaHash,
  };
}

async function loadAuthoredToolDefinition(toolDir: string): Promise<Readonly<Record<string, unknown>> | undefined> {
  const sourcePath = path.join(toolDir, "src", "index.ts");
  if (!existsSync(sourcePath)) {
    return undefined;
  }
  try {
    const imported = await import(`${pathToFileURL(sourcePath).href}?runx_build=${Date.now()}`);
    const tool = imported.default;
    if (!isPlainRecord(tool) || typeof tool.name !== "string") {
      return undefined;
    }
    const output = isPlainRecord(tool.output) ? tool.output : undefined;
    const wrapAs = typeof output?.wrap_as === "string" ? output.wrap_as : undefined;
    return {
      name: tool.name,
      version: typeof tool.version === "string" ? tool.version : undefined,
      description: typeof tool.description === "string" ? tool.description : undefined,
      source: isPlainRecord(tool.source)
        ? tool.source
        : {
            type: "cli-tool",
            command: "node",
            args: ["./run.mjs"],
          },
      inputs: serializeAuthoringInputs(isPlainRecord(tool.inputs) ? tool.inputs : {}),
      output: output
        ? {
            ...(typeof output.packet === "string" ? { packet: output.packet } : {}),
            ...(wrapAs ? { wrap_as: wrapAs } : {}),
          }
        : undefined,
      scopes: Array.isArray(tool.scopes) ? tool.scopes.filter((scope): scope is string => typeof scope === "string") : [],
      runx: wrapAs ? { artifacts: { wrap_as: wrapAs } } : undefined,
    };
  } catch {
    return undefined;
  }
}

function serializeAuthoringInputs(inputs: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(inputs).map(([name, parser]) => {
      const manifest = isPlainRecord(parser) && isPlainRecord(parser.manifest)
        ? parser.manifest
        : { type: "json", required: !(isPlainRecord(parser) && parser.optional === true) };
      return [name, manifest];
    }),
  );
}

async function writeAuthoredToolShim(toolDir: string): Promise<void> {
  await writeFile(
    path.join(toolDir, "run.mjs"),
    [
      "#!/usr/bin/env node",
      "import { register } from \"node:module\";",
      "import { pathToFileURL } from \"node:url\";",
      "register(\"tsx/esm\", pathToFileURL(\"./\"));",
      "const tool = (await import(\"./src/index.ts\")).default;",
      "await tool.main();",
      "",
    ].join("\n"),
  );
}

function normalizeToolOutput(raw: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const runx = isPlainRecord(raw.runx) ? raw.runx : undefined;
  const artifacts = isPlainRecord(runx?.artifacts) ? runx.artifacts : undefined;
  if (typeof artifacts?.wrap_as === "string") {
    return { wrap_as: artifacts.wrap_as };
  }
  if (isPlainRecord(artifacts?.named_emits)) {
    return { named_emits: artifacts.named_emits };
  }
  return {};
}

async function hashToolSource(toolDir: string): Promise<string> {
  const candidates = [
    path.join(toolDir, "src", "index.ts"),
    path.join(toolDir, "run.mjs"),
  ];
  const hash = createHash("sha256");
  let found = false;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    found = true;
    hash.update(toProjectPath(toolDir, candidate));
    hash.update("\0");
    hash.update(await readFile(candidate));
    hash.update("\0");
  }
  if (!found) {
    hash.update("no-source");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function discoverToolDirectories(root: string): Promise<readonly string[]> {
  const toolsRoot = path.join(root, "tools");
  const directories: string[] = [];
  for (const namespaceEntry of await safeReadDir(toolsRoot)) {
    if (!namespaceEntry.isDirectory()) continue;
    for (const toolEntry of await safeReadDir(path.join(toolsRoot, namespaceEntry.name))) {
      if (toolEntry.isDirectory()) {
        directories.push(path.join(toolsRoot, namespaceEntry.name, toolEntry.name));
      }
    }
  }
  return directories.sort();
}

async function discoverLegacyToolDirectories(root: string): Promise<readonly string[]> {
  return (await discoverToolDirectories(root)).filter((toolDir) => existsSync(path.join(toolDir, "tool.yaml")));
}

function renderToolCommandResult(result: ToolBuildReport | ToolMigrateReport, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(process.stdout, env);
  const count = "built" in result ? result.built.length : result.migrated.length;
  const lines = [
    "",
    `  ${statusIcon(result.status, t)}  ${t.bold}${"built" in result ? "tool build" : "tool migrate"}${t.reset}  ${t.dim}${count} tool(s)${t.reset}`,
  ];
  for (const error of result.errors) {
    lines.push(`  ${t.red}${error}${t.reset}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function handleDevCommand(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<DevReport> {
  const root = resolveRunxWorkspaceBase(env);
  const unitPath = parsed.devPath ? resolvePathFromUserInput(parsed.devPath, env) : root;
  const build = await handleToolBuildCommand({ ...parsed, toolAction: "build", toolAll: true }, env);
  if (build.status === "failure") {
    return {
      schema: "runx.dev.v1",
      status: "failure",
      doctor: {
        schema: "runx.doctor.v1",
        status: "failure",
        summary: { errors: build.errors.length, warnings: 0, infos: 0 },
        diagnostics: build.errors.map((error, index) => createDoctorDiagnostic({
          id: "runx.tool.manifest.build_failed",
          severity: "error",
          title: "Tool build failed",
          message: error,
          target: { kind: "tool" },
          location: { path: "." },
          evidence: { index },
          repairs: [{
            id: "repair_tool_build",
            kind: "manual",
            confidence: "medium",
            risk: "low",
            requires_human_review: false,
          }],
        })),
      },
      fixtures: [],
    };
  }
  const doctor = await handleDoctorCommand({ ...parsed, doctorPath: root }, env);
  if (doctor.status === "failure") {
    return { schema: "runx.dev.v1", status: "failure", doctor, fixtures: [] };
  }
  const fixturePaths = await discoverFixturePaths(unitPath, root);
  const selectedLane = parsed.devLane ?? "deterministic";
  const startedAt = Date.now();
  const fixtures: DevFixtureResult[] = [];
  for (const fixturePath of fixturePaths) {
    fixtures.push(await runDevFixture(root, fixturePath, selectedLane, parsed, env));
  }
  const status = fixtures.some((fixture) => fixture.status === "failure")
    ? "failure"
    : fixtures.some((fixture) => fixture.status === "success")
      ? "success"
      : "skipped";
  const receipt = await writeLocalReceipt({
    receiptDir: parsed.receiptDir ? resolvePathFromUserInput(parsed.receiptDir, env) : resolveDefaultReceiptDir(env),
    runxHome: resolveRunxHomeDir(env),
    skillName: "runx.dev",
    sourceType: "dev",
    inputs: { path: parsed.devPath, lane: selectedLane },
    stdout: JSON.stringify({ fixtures: fixtures.map((fixture) => ({ name: fixture.name, status: fixture.status })) }),
    stderr: "",
    execution: {
      status: status === "failure" ? "failure" : "success",
      exitCode: status === "failure" ? 1 : 0,
      signal: null,
      durationMs: Date.now() - startedAt,
      metadata: {
        dev: {
          fixture_count: fixtures.length,
          selected_lane: selectedLane,
        },
      },
    },
  });
  return {
    schema: "runx.dev.v1",
    status,
    doctor,
    fixtures,
    receipt_id: receipt.id,
  };
}

async function discoverFixturePaths(unitPath: string, root: string): Promise<readonly string[]> {
  const statPath = existsSync(unitPath) ? unitPath : root;
  const directFixtures = path.join(statPath, "fixtures");
  const paths: string[] = [];
  for (const entry of await safeReadDir(directFixtures)) {
    if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      paths.push(path.join(directFixtures, entry.name));
    }
  }
  if (paths.length > 0 && statPath !== root) {
    return paths.sort();
  }
  for (const toolDir of await discoverToolDirectories(root)) {
    for (const entry of await safeReadDir(path.join(toolDir, "fixtures"))) {
      if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        paths.push(path.join(toolDir, "fixtures", entry.name));
      }
    }
  }
  return paths.sort();
}

async function runDevFixture(
  root: string,
  fixturePath: string,
  selectedLane: string,
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
): Promise<DevFixtureResult> {
  const startedAt = Date.now();
  const fixture = parseYaml(await readFile(fixturePath, "utf8")) as unknown;
  if (!isPlainRecord(fixture)) {
    return failedFixture(path.basename(fixturePath), "unknown", {}, startedAt, [{
      path: "",
      kind: "exact_mismatch",
      message: "Fixture must parse to an object.",
    }]);
  }
  const name = typeof fixture.name === "string" ? fixture.name : path.basename(fixturePath, path.extname(fixturePath));
  const lane = typeof fixture.lane === "string" ? fixture.lane : "deterministic";
  const target = isPlainRecord(fixture.target) ? fixture.target : {};
  if (selectedLane !== "all" && lane !== selectedLane) {
    return {
      name,
      lane,
      target,
      status: "skipped",
      duration_ms: Date.now() - startedAt,
      assertions: [],
      skip_reason: `lane ${lane} excluded by --lane ${selectedLane}`,
    };
  }
  if (lane === "agent") {
    return parsed.devRecord
      ? recordReplayFixture(root, fixturePath, fixture, name, lane, target, startedAt, parsed, env)
      : validateReplayFixture(root, fixturePath, fixture, startedAt);
  }
  if (lane !== "deterministic") {
    return {
      name,
      lane,
      target,
      status: "skipped",
      duration_ms: Date.now() - startedAt,
      assertions: [],
      skip_reason: `${lane} fixtures are parsed but not executed in dev v1`,
    };
  }
  const kind = typeof target.kind === "string" ? target.kind : undefined;
  if (kind === "tool") {
    return runToolFixture(root, fixturePath, fixture, name, lane, target, startedAt, env);
  }
  if (kind === "skill" || kind === "chain") {
    return runSkillFixture(root, fixture, name, lane, target, startedAt, env);
  }
  return failedFixture(name, lane, target, startedAt, [{
    path: "target.kind",
    expected: "tool | skill | chain",
    actual: target.kind,
    kind: "exact_mismatch",
    message: "Fixture target.kind must be tool, skill, or chain.",
  }]);
}

async function runToolFixture(
  root: string,
  fixturePath: string,
  fixture: Readonly<Record<string, unknown>>,
  name: string,
  lane: string,
  target: Readonly<Record<string, unknown>>,
  startedAt: number,
  env: NodeJS.ProcessEnv,
): Promise<DevFixtureResult> {
  const ref = typeof target.ref === "string" ? target.ref : "";
  const toolDir = resolveToolDirFromRef(root, ref);
  if (!toolDir) {
    return failedFixture(name, lane, target, startedAt, [{
      path: "target.ref",
      expected: "existing tool",
      actual: ref,
      kind: "exact_mismatch",
      message: `Tool ${ref} was not found.`,
    }]);
  }
  const manifest = validateToolManifest(parseToolManifestJson(await readFile(path.join(toolDir, "manifest.json"), "utf8")));
  const command = manifest.source.command ?? "node";
  const args = manifest.source.args ?? ["./run.mjs"];
  const workspace = await prepareFixtureWorkspace(root, fixturePath, fixture, env);
  try {
    const fixtureEnv = materializeFixtureEnv(fixture.env, workspace.tokens);
    const inputs = materializeFixtureValue(isPlainRecord(fixture.inputs) ? fixture.inputs : {}, workspace.tokens);
    const execution = await runProcess(command, args, {
      cwd: toolDir,
      env: {
        ...env,
        ...fixtureEnv,
        RUNX_INPUTS_JSON: JSON.stringify(inputs),
        RUNX_CWD: workspace.root ?? root,
        RUNX_REPO_ROOT: root,
        ...(workspace.root ? { RUNX_FIXTURE_ROOT: workspace.root } : {}),
      },
    });
    const output = parseJsonMaybe(execution.stdout);
    const assertions = await assertFixtureExpectation(root, fixture.expect, execution.exitCode, output);
    return {
      name,
      lane,
      target,
      status: assertions.length === 0 ? "success" : "failure",
      duration_ms: Date.now() - startedAt,
      assertions,
      output,
    };
  } finally {
    await workspace.cleanup();
  }
}

async function prepareFixtureWorkspace(
  root: string,
  fixturePath: string,
  fixture: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
): Promise<PreparedFixtureWorkspace> {
  const workspace = isPlainRecord(fixture.workspace) ? fixture.workspace : undefined;
  const fixtureDir = path.dirname(fixturePath);
  if (!workspace) {
    return {
      tokens: {
        RUNX_REPO_ROOT: root,
        RUNX_FIXTURE_FILE: fixturePath,
        RUNX_FIXTURE_DIR: fixtureDir,
      },
      cleanup: async () => {},
    };
  }

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "runx-fixture-"));
  const tokens = {
    RUNX_REPO_ROOT: root,
    RUNX_FIXTURE_ROOT: fixtureRoot,
    RUNX_FIXTURE_FILE: fixturePath,
    RUNX_FIXTURE_DIR: fixtureDir,
  };
  try {
    await writeFixtureFileMap(fixtureRoot, workspace.files, tokens, 0o644);
    await writeFixtureFileMap(fixtureRoot, workspace.json_files, tokens, 0o644, true);
    await writeFixtureFileMap(fixtureRoot, workspace.executable_files, tokens, 0o755);
    await initializeFixtureGit(fixtureRoot, workspace.git, tokens, env);
    return {
      root: fixtureRoot,
      tokens,
      cleanup: async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writeFixtureFileMap(
  root: string,
  value: unknown,
  tokens: Readonly<Record<string, string>>,
  mode: number,
  forceJson = false,
): Promise<void> {
  if (!isPlainRecord(value)) {
    return;
  }
  for (const [relativePath, rawContents] of Object.entries(value)) {
    const targetPath = resolveInsideFixtureRoot(root, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    const contents = forceJson
      ? `${JSON.stringify(materializeFixtureValue(rawContents, tokens), null, 2)}\n`
      : typeof rawContents === "string"
        ? materializeFixtureString(rawContents, tokens)
        : `${JSON.stringify(materializeFixtureValue(rawContents, tokens), null, 2)}\n`;
    await writeFile(targetPath, contents, { mode });
  }
}

async function initializeFixtureGit(
  root: string,
  value: unknown,
  tokens: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const git = value === true ? {} : isPlainRecord(value) ? value : undefined;
  if (!git) {
    return;
  }
  const branch = typeof git.initial_branch === "string" && git.initial_branch.trim()
    ? git.initial_branch.trim()
    : "main";
  await runRequiredProcess("git", ["init", "-b", branch], root, env);
  await runRequiredProcess("git", ["config", "user.email", "fixture@example.com"], root, env);
  await runRequiredProcess("git", ["config", "user.name", "Runx Fixture"], root, env);
  if (git.commit !== false) {
    await runRequiredProcess("git", ["add", "."], root, env);
    await runRequiredProcess("git", ["commit", "-m", "fixture baseline"], root, env);
  }
  await writeFixtureFileMap(root, git.dirty_files, tokens, 0o644);
}

async function runRequiredProcess(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runProcess(command, args, { cwd, env });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function materializeFixtureEnv(value: unknown, tokens: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!isPlainRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .map(([key, nested]) => [key, materializeFixtureString(String(nested), tokens)]),
  );
}

function materializeFixtureValue(value: unknown, tokens: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") {
    return materializeFixtureString(value, tokens);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materializeFixtureValue(entry, tokens));
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, materializeFixtureValue(nested, tokens)]),
  );
}

function materializeFixtureString(value: string, tokens: Readonly<Record<string, string>>): string {
  let resolved = value;
  for (const [key, replacement] of Object.entries(tokens)) {
    resolved = resolved.split(`$${key}`).join(replacement);
    resolved = resolved.split(`\${${key}}`).join(replacement);
  }
  return resolved;
}

function resolveInsideFixtureRoot(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`fixture workspace path must be relative: ${relativePath}`);
  }
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
    throw new Error(`fixture workspace path escapes root: ${relativePath}`);
  }
  return resolved;
}

async function runSkillFixture(
  root: string,
  fixture: Readonly<Record<string, unknown>>,
  name: string,
  lane: string,
  target: Readonly<Record<string, unknown>>,
  startedAt: number,
  env: NodeJS.ProcessEnv,
): Promise<DevFixtureResult> {
  const ref = typeof target.ref === "string" ? target.ref : "";
  const skillPath = resolveSkillDirFromRef(root, ref);
  if (!skillPath) {
    return failedFixture(name, lane, target, startedAt, [{
      path: "target.ref",
      expected: "existing skill",
      actual: ref,
      kind: "exact_mismatch",
      message: `Skill or chain ${ref} was not found.`,
    }]);
  }
  const result = await runLocalSkill({
    skillPath,
    inputs: isPlainRecord(fixture.inputs) ? fixture.inputs : {},
    caller: createFixtureCaller(fixture, env),
    env: { ...env, RUNX_CWD: root },
    receiptDir: resolveDefaultReceiptDir(env),
    runxHome: resolveRunxHomeDir(env),
    registryStore: await resolveRegistryStoreForChains(env),
    adapters: createDefaultSkillAdapters(),
  });
  const success = result.status === "success";
  const output = success ? parseJsonMaybe(result.execution.stdout) : result;
  const assertions = await assertFixtureExpectation(root, fixture.expect, success ? 0 : 1, output);
  return {
    name,
    lane,
    target,
    status: assertions.length === 0 ? "success" : "failure",
    duration_ms: Date.now() - startedAt,
    assertions,
    output,
  };
}

function createFixtureCaller(fixture: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv): Caller {
  const caller = isPlainRecord(fixture.caller) ? fixture.caller : {};
  const answers = isPlainRecord(caller.answers) ? caller.answers : {};
  const approvals = isPlainRecord(caller.approvals)
    ? Object.fromEntries(Object.entries(caller.approvals).filter(([, value]) => typeof value === "boolean")) as Readonly<Record<string, boolean>>
    : typeof caller.approvals === "boolean"
      ? caller.approvals
      : undefined;
  return createNonInteractiveCaller(answers, approvals, createAgentRuntimeLoader(env));
}

async function recordReplayFixture(
  root: string,
  fixturePath: string,
  fixture: Readonly<Record<string, unknown>>,
  name: string,
  lane: string,
  target: Readonly<Record<string, unknown>>,
  startedAt: number,
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
): Promise<DevFixtureResult> {
  if (!parsed.devRealAgents && !isPlainRecord(fixture.caller)) {
    return failedFixture(name, lane, target, startedAt, [{
      path: "agent.mode",
      expected: "--real-agents or fixture.caller.answers",
      actual: "record",
      kind: "exact_mismatch",
      message: "Recording an agent fixture requires --real-agents or fixture caller answers.",
    }]);
  }
  const kind = typeof target.kind === "string" ? target.kind : undefined;
  const result = kind === "skill" || kind === "chain"
    ? await runSkillFixture(root, fixture, name, lane, target, startedAt, env)
    : failedFixture(name, lane, target, startedAt, [{
        path: "target.kind",
        expected: "skill | chain",
        actual: target.kind,
        kind: "exact_mismatch",
        message: "Agent replay recording requires a skill or chain target.",
      }]);
  const replayPath = fixturePath.replace(/\.ya?ml$/i, ".replay.json");
  const cassette = {
    schema: "runx.replay.v1",
    fixture: name,
    prompt_fingerprint: fixtureFingerprint(fixture),
    recorded_at: new Date().toISOString(),
    target,
    status: result.status,
    outputs: extractReplayOutputs(fixture, result.output),
    assertions: result.assertions,
    usage: {
      mode: parsed.devRealAgents ? "real" : "fixture_answers",
    },
  };
  await writeJsonFile(replayPath, cassette);
  return {
    ...result,
    replay_path: toProjectPath(root, replayPath),
  };
}

async function validateReplayFixture(
  root: string,
  fixturePath: string,
  fixture: Readonly<Record<string, unknown>>,
  startedAt: number,
): Promise<DevFixtureResult> {
  const target = isPlainRecord(fixture.target) ? fixture.target : {};
  const name = typeof fixture.name === "string" ? fixture.name : path.basename(fixturePath, path.extname(fixturePath));
  const replayPath = fixturePath.replace(/\.ya?ml$/i, ".replay.json");
  if (!existsSync(replayPath)) {
    return failedFixture(name, "agent", target, startedAt, [{
      path: "agent.mode",
      expected: "replay cassette",
      actual: "missing",
      kind: "exact_mismatch",
      message: `Missing replay cassette ${toProjectPath(root, replayPath)}.`,
    }]);
  }
  const replay = JSON.parse(readFileSync(replayPath, "utf8")) as unknown;
  const fingerprint = fixtureFingerprint(fixture);
  if (isPlainRecord(replay) && replay.prompt_fingerprint && replay.prompt_fingerprint !== fingerprint) {
    return failedFixture(name, "agent", target, startedAt, [{
      path: "replay.prompt_fingerprint",
      expected: fingerprint,
      actual: replay.prompt_fingerprint,
      kind: "exact_mismatch",
      message: "Replay cassette is stale for this fixture.",
    }]);
  }
  if (!isPlainRecord(replay)) {
    return failedFixture(name, "agent", target, startedAt, [{
      path: "replay",
      expected: "object",
      actual: replay,
      kind: "type_mismatch",
      message: "Replay cassette must be a JSON object.",
    }]);
  }
  const replayStatus = replay.status === "failure" ? 1 : 0;
  const replayOutput = isPlainRecord(replay.outputs) ? replay.outputs : replay.output;
  const assertions = await assertFixtureExpectation(root, fixture.expect, replayStatus, replayOutput);
  return {
    name,
    lane: "agent",
    target,
    status: assertions.length === 0 ? "success" : "failure",
    duration_ms: Date.now() - startedAt,
    assertions,
    output: replayOutput,
    replay_path: toProjectPath(root, replayPath),
  };
}

function fixtureFingerprint(fixture: Readonly<Record<string, unknown>>): string {
  return sha256Stable({
    target: fixture.target,
    inputs: fixture.inputs,
    agent: fixture.agent,
    expect: fixture.expect,
  });
}

function extractReplayOutputs(fixture: Readonly<Record<string, unknown>>, output: unknown): unknown {
  const expectRecord = isPlainRecord(fixture.expect) ? fixture.expect : {};
  const outputsExpectation = isPlainRecord(expectRecord.outputs) ? expectRecord.outputs : undefined;
  if (!outputsExpectation || !isPlainRecord(output)) {
    return output;
  }
  return Object.fromEntries(
    Object.keys(outputsExpectation).map((name) => [name, selectNamedOutput(output, name)]),
  );
}

async function assertFixtureExpectation(
  root: string,
  expectation: unknown,
  exitCode: number,
  output: unknown,
): Promise<readonly FixtureAssertion[]> {
  const assertions: FixtureAssertion[] = [];
  const expectRecord = isPlainRecord(expectation) ? expectation : {};
  const expectedStatus = typeof expectRecord.status === "string" ? expectRecord.status : "success";
  const actualStatus = exitCode === 0 ? "success" : "failure";
  if (expectedStatus !== actualStatus) {
    assertions.push({
      path: "expect.status",
      expected: expectedStatus,
      actual: actualStatus,
      kind: "status_mismatch",
      message: `Expected status ${expectedStatus}, got ${actualStatus}.`,
    });
  }
  const outputExpectation = isPlainRecord(expectRecord.output) ? expectRecord.output : undefined;
  if (outputExpectation) {
    assertions.push(...await assertOutputExpectation(root, outputExpectation, output, "expect.output"));
  }
  const outputsExpectation = isPlainRecord(expectRecord.outputs) ? expectRecord.outputs : undefined;
  if (outputsExpectation) {
    for (const [name, expected] of Object.entries(outputsExpectation)) {
      const actual = selectNamedOutput(output, name);
      assertions.push(...await assertOutputExpectation(root, expected, actual, `expect.outputs.${name}`));
    }
  }
  return assertions;
}

async function assertOutputExpectation(
  root: string,
  expectation: unknown,
  output: unknown,
  basePath: string,
): Promise<readonly FixtureAssertion[]> {
  const assertions: FixtureAssertion[] = [];
  const outputExpectation = isPlainRecord(expectation) ? expectation : {};
  if ("exact" in outputExpectation && !deepEqual(output, outputExpectation.exact)) {
    assertions.push({
      path: `${basePath}.exact`,
      expected: outputExpectation.exact,
      actual: output,
      kind: "exact_mismatch",
      message: "Output did not exactly match.",
    });
  }
  if ("subset" in outputExpectation) {
    assertions.push(...assertSubset(outputExpectation.subset, output, ""));
  }
  if (typeof outputExpectation.matches_packet === "string") {
    assertions.push(...await assertMatchesPacket(root, outputExpectation.matches_packet, output, `${basePath}.matches_packet`));
  }
  return assertions;
}

function selectNamedOutput(output: unknown, name: string): unknown {
  if (!isPlainRecord(output)) {
    return output;
  }
  if (name in output) {
    return output[name];
  }
  if (isPlainRecord(output.data) && name in output.data) {
    return output.data[name];
  }
  return output;
}

function assertSubset(expected: unknown, actual: unknown, basePath: string): readonly FixtureAssertion[] {
  if (!isPlainRecord(expected)) {
    return deepEqual(expected, actual) ? [] : [{
      path: basePath,
      expected,
      actual,
      kind: "subset_miss",
      message: "Subset value did not match.",
    }];
  }
  const assertions: FixtureAssertion[] = [];
  const actualRecord = isPlainRecord(actual) ? actual : {};
  for (const [key, value] of Object.entries(expected)) {
    const pathKey = basePath ? `${basePath}.${key}` : key;
    assertions.push(...assertSubset(value, actualRecord[key], pathKey));
  }
  return assertions;
}

async function assertMatchesPacket(
  root: string,
  packetId: string,
  output: unknown,
  basePath: string,
): Promise<readonly FixtureAssertion[]> {
  const index = await buildLocalPacketIndex(root, { writeCache: false });
  const packet = index.packets.find((candidate) => candidate.id === packetId);
  if (!packet) {
    return [{
      path: basePath,
      expected: packetId,
      actual: index.packets.map((candidate) => candidate.id),
      kind: "packet_invalid",
      message: `Packet ${packetId} is not declared in this package index.`,
    }];
  }
  const outputRecord = isPlainRecord(output) ? output : undefined;
  const actualPacketId = typeof outputRecord?.schema === "string" ? outputRecord.schema : undefined;
  if (actualPacketId && actualPacketId !== packetId) {
    return [{
      path: basePath,
      expected: packetId,
      actual: actualPacketId,
      kind: "packet_invalid",
      message: "Output packet schema did not match.",
    }];
  }
  const schema = JSON.parse(await readFile(path.resolve(root, packet.path), "utf8")) as unknown;
  const data = outputRecord && "data" in outputRecord ? outputRecord.data : output;
  return validateJsonSchemaValue(schema, data, `${basePath}.data`);
}

function validateJsonSchemaValue(schema: unknown, value: unknown, basePath: string): readonly FixtureAssertion[] {
  if (!isPlainRecord(schema)) {
    return [{
      path: basePath,
      expected: "JSON Schema object",
      actual: schema,
      kind: "packet_invalid",
      message: "Packet schema artifact is not an object.",
    }];
  }
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const branches = (Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf) as readonly unknown[];
    const branchErrors = branches.map((branch) => validateJsonSchemaValue(branch, value, basePath));
    if (branchErrors.some((errors) => errors.length === 0)) {
      return [];
    }
    return branchErrors[0] ?? [];
  }
  const type = schema.type;
  const allowedTypes = Array.isArray(type) ? type.filter((entry): entry is string => typeof entry === "string") : typeof type === "string" ? [type] : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((entry) => jsonTypeMatches(entry, value))) {
    return [{
      path: basePath,
      expected: allowedTypes.join(" | "),
      actual: jsonTypeName(value),
      kind: "type_mismatch",
      message: `Expected ${allowedTypes.join(" | ")}, got ${jsonTypeName(value)}.`,
    }];
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    return [{
      path: basePath,
      expected: schema.const,
      actual: value,
      kind: "exact_mismatch",
      message: "Value did not match schema const.",
    }];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(entry, value))) {
    return [{
      path: basePath,
      expected: schema.enum,
      actual: value,
      kind: "exact_mismatch",
      message: "Value did not match schema enum.",
    }];
  }
  const assertions: FixtureAssertion[] = [];
  if ((schema.type === "object" || isPlainRecord(schema.properties)) && isPlainRecord(value)) {
    const properties = isPlainRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : [];
    for (const key of required) {
      if (!(key in value)) {
        assertions.push({
          path: `${basePath}.${key}`,
          expected: "required",
          actual: "missing",
          kind: "subset_miss",
          message: "Required packet field is missing.",
        });
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        assertions.push(...validateJsonSchemaValue(propertySchema, value[key], `${basePath}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          assertions.push({
            path: `${basePath}.${key}`,
            expected: "no additional property",
            actual: value[key],
            kind: "packet_invalid",
            message: "Packet includes an undeclared field.",
          });
        }
      }
    }
  }
  if ((schema.type === "array" || schema.items !== undefined) && Array.isArray(value) && schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      assertions.push(...validateJsonSchemaValue(schema.items, value[index], `${basePath}[${index}]`));
    }
  }
  return assertions;
}

function jsonTypeMatches(type: string, value: unknown): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return isPlainRecord(value);
  return typeof value === type;
}

function jsonTypeName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function failedFixture(
  name: string,
  lane: string,
  target: Readonly<Record<string, unknown>>,
  startedAt: number,
  assertions: readonly FixtureAssertion[],
): DevFixtureResult {
  return {
    name,
    lane,
    target,
    status: "failure",
    duration_ms: Date.now() - startedAt,
    assertions,
  };
}

function renderDevResult(result: DevReport, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(process.stdout, env);
  const lines = [
    "",
    `  ${statusIcon(result.status, t)}  ${t.bold}dev${t.reset}  ${t.dim}${result.fixtures.length} fixture(s)${t.reset}`,
  ];
  for (const fixture of result.fixtures) {
    lines.push(`  ${statusIcon(fixture.status, t)}  ${fixture.lane.padEnd(14)} ${fixture.name}  ${t.dim}${fixture.duration_ms}ms${t.reset}`);
    for (const assertion of fixture.assertions.slice(0, 3)) {
      lines.push(`     ${assertion.path}: ${assertion.message}`);
    }
  }
  if (result.receipt_id) {
    lines.push(`  ${t.dim}receipt${t.reset}  ${result.receipt_id}`);
  }
  lines.push("");
  return lines.join("\n");
}

function resolveToolDirFromRef(root: string, ref: string): string | undefined {
  const parts = ref.split(".").filter(Boolean);
  if (parts.length < 2) return undefined;
  const candidate = path.join(root, "tools", ...parts);
  return existsSync(path.join(candidate, "manifest.json")) ? candidate : undefined;
}

function resolveSkillDirFromRef(root: string, ref: string): string | undefined {
  const candidates = [
    path.join(root, "skills", ref),
    path.resolve(root, ref),
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "SKILL.md")));
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function handleDoctorCommand(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<DoctorReport> {
  const root = parsed.doctorPath
    ? resolvePathFromUserInput(parsed.doctorPath, env)
    : resolveRunxWorkspaceBase(env);
  const diagnostics = [
    ...await discoverToolDoctorDiagnostics(root),
    ...await discoverSkillDoctorDiagnostics(root),
    ...await discoverPacketDoctorDiagnostics(root),
  ];
  if (parsed.doctorFix) {
    const applied = await applySafeDoctorRepairs(root, diagnostics);
    if (applied > 0) {
      return handleDoctorCommand({ ...parsed, doctorFix: false }, env);
    }
  }
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const infos = diagnostics.filter((diagnostic) => diagnostic.severity === "info").length;
  return {
    schema: "runx.doctor.v1",
    status: errors > 0 ? "failure" : "success",
    summary: {
      errors,
      warnings,
      infos,
    },
    diagnostics: diagnostics.sort((left, right) => left.location.path.localeCompare(right.location.path) || left.id.localeCompare(right.id)),
  };
}

async function applySafeDoctorRepairs(root: string, diagnostics: readonly DoctorDiagnostic[]): Promise<number> {
  let applied = 0;
  for (const diagnostic of diagnostics) {
    const repair = diagnostic.repairs.find((candidate) =>
      candidate.confidence === "high"
      && candidate.requires_human_review === false
      && candidate.risk === "low"
      && (candidate.kind === "create_file" || candidate.kind === "replace_file")
      && typeof candidate.path === "string"
      && typeof candidate.contents === "string"
    );
    if (!repair?.path || repair.contents === undefined) {
      continue;
    }
    const targetPath = path.resolve(root, repair.path);
    if (!targetPath.startsWith(`${root}${path.sep}`) && targetPath !== root) {
      continue;
    }
    if (repair.kind === "create_file" && existsSync(targetPath)) {
      continue;
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, repair.contents);
    applied += 1;
    break;
  }
  return applied;
}

async function discoverToolDoctorDiagnostics(root: string): Promise<readonly DoctorDiagnostic[]> {
  const toolsRoot = path.join(root, "tools");
  const diagnostics: DoctorDiagnostic[] = [];
  for (const namespaceEntry of await safeReadDir(toolsRoot)) {
    if (!namespaceEntry.isDirectory()) {
      continue;
    }
    const namespaceDir = path.join(toolsRoot, namespaceEntry.name);
    for (const toolEntry of await safeReadDir(namespaceDir)) {
      if (!toolEntry.isDirectory()) {
        continue;
      }
      const toolDir = path.join(namespaceDir, toolEntry.name);
      const legacyPath = path.join(toolDir, "tool.yaml");
      if (existsSync(legacyPath)) {
        const relativePath = toProjectPath(root, legacyPath);
        diagnostics.push(createDoctorDiagnostic({
          id: "runx.tool.manifest.legacy_format",
          severity: "error",
          title: "Legacy tool.yaml is no longer supported",
          message: `Tool ${namespaceEntry.name}.${toolEntry.name} still uses tool.yaml. Runx resolves manifest.json only.`,
          target: {
            kind: "tool",
            ref: `${namespaceEntry.name}.${toolEntry.name}`,
          },
          location: {
            path: relativePath,
          },
          evidence: {
            expected_manifest: toProjectPath(root, path.join(toolDir, "manifest.json")),
          },
          repairs: [{
            id: "migrate_to_define_tool",
            kind: "run_command",
            confidence: "high",
            risk: "medium",
            command: `runx tool migrate ${toProjectPath(root, toolDir)}`,
            requires_human_review: true,
          }],
        }));
      }

      const manifestPath = path.join(toolDir, "manifest.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      try {
        const manifestContents = await readFile(manifestPath, "utf8");
        validateToolManifest(parseToolManifestJson(manifestContents));
        const manifest = JSON.parse(manifestContents) as unknown;
        if (isPlainRecord(manifest)) {
          const fixtureCount = await countYamlFiles(path.join(toolDir, "fixtures"));
          if (fixtureCount === 0) {
            diagnostics.push(createDoctorDiagnostic({
              id: "runx.tool.fixture.missing",
              severity: "error",
              title: "Tool has no deterministic fixture",
              message: `Tool ${namespaceEntry.name}.${toolEntry.name} declares a manifest but has no deterministic fixture.`,
              target: {
                kind: "tool",
                ref: `${namespaceEntry.name}.${toolEntry.name}`,
              },
              location: {
                path: toProjectPath(root, manifestPath),
              },
              evidence: {
                fixture_count: fixtureCount,
                expected_location: toProjectPath(root, path.join(toolDir, "fixtures")),
              },
              repairs: [{
                id: "add_tool_fixture",
                kind: "manual",
                confidence: "medium",
                risk: "low",
                requires_human_review: false,
              }],
            }));
          }
          const actualSourceHash = await hashToolSource(toolDir);
          const actualSchemaHash = sha256Stable({
            inputs: manifest.inputs,
            output: manifest.output,
            artifacts: isPlainRecord(manifest.runx) ? manifest.runx.artifacts : undefined,
          });
          if (typeof manifest.source_hash === "string" && manifest.source_hash !== actualSourceHash) {
            diagnostics.push(createDoctorDiagnostic({
              id: "runx.tool.manifest.stale",
              severity: "error",
              title: "Tool manifest is stale",
              message: `Tool ${namespaceEntry.name}.${toolEntry.name} source_hash does not match current source files.`,
              target: {
                kind: "tool",
                ref: `${namespaceEntry.name}.${toolEntry.name}`,
              },
              location: {
                path: toProjectPath(root, manifestPath),
                json_pointer: "/source_hash",
              },
              evidence: {
                expected: actualSourceHash,
                actual: manifest.source_hash,
              },
              repairs: [{
                id: "rebuild_tool_manifest",
                kind: "run_command",
                confidence: "high",
                risk: "low",
                command: `runx tool build ${toProjectPath(root, toolDir)}`,
                requires_human_review: false,
              }],
            }));
          }
          if (typeof manifest.schema_hash === "string" && manifest.schema_hash !== actualSchemaHash) {
            diagnostics.push(createDoctorDiagnostic({
              id: "runx.tool.manifest.stale",
              severity: "error",
              title: "Tool manifest schema hash is stale",
              message: `Tool ${namespaceEntry.name}.${toolEntry.name} schema_hash does not match current manifest inputs/output.`,
              target: {
                kind: "tool",
                ref: `${namespaceEntry.name}.${toolEntry.name}`,
              },
              location: {
                path: toProjectPath(root, manifestPath),
                json_pointer: "/schema_hash",
              },
              evidence: {
                expected: actualSchemaHash,
                actual: manifest.schema_hash,
              },
              repairs: [{
                id: "rebuild_tool_manifest",
                kind: "run_command",
                confidence: "high",
                risk: "low",
                command: `runx tool build ${toProjectPath(root, toolDir)}`,
                requires_human_review: false,
              }],
            }));
          }
        }
      } catch (error) {
        diagnostics.push(createDoctorDiagnostic({
          id: "runx.tool.manifest.invalid",
          severity: "error",
          title: "Tool manifest is invalid",
          message: error instanceof Error ? error.message : String(error),
          target: {
            kind: "tool",
            ref: `${namespaceEntry.name}.${toolEntry.name}`,
          },
          location: {
            path: toProjectPath(root, manifestPath),
          },
          repairs: [{
            id: "repair_manifest",
            kind: "manual",
            confidence: "medium",
            risk: "low",
            requires_human_review: false,
          }],
        }));
      }
    }
  }
  return diagnostics;
}

async function discoverSkillDoctorDiagnostics(root: string): Promise<readonly DoctorDiagnostic[]> {
  const diagnostics: DoctorDiagnostic[] = [];
  for (const profilePath of await discoverSkillProfilePaths(root)) {
    const skillDir = path.dirname(profilePath);
    const skillName = skillDir === root ? path.basename(root) : path.basename(skillDir);
    try {
      const manifest = validateRunnerManifest(parseRunnerManifestYaml(await readFile(profilePath, "utf8")));
      const fixtureCount = await countYamlFiles(path.join(skillDir, "fixtures"));
      const harnessCaseCount = manifest.harness?.cases.length ?? 0;
      if (fixtureCount === 0 && harnessCaseCount === 0) {
        diagnostics.push(createDoctorDiagnostic({
          id: "runx.skill.fixture.missing",
          severity: "error",
          title: "Skill has no harness coverage",
          message: `Skill ${skillName} declares an execution profile but has no fixtures or inline harness.cases.`,
          target: {
            kind: "skill",
            ref: skillName,
          },
          location: {
            path: toProjectPath(root, profilePath),
            json_pointer: "/harness",
          },
          evidence: {
            fixture_count: fixtureCount,
            harness_case_count: harnessCaseCount,
          },
          repairs: [{
            id: "add_inline_harness_case",
            kind: "manual",
            confidence: "medium",
            risk: "low",
            requires_human_review: false,
          }],
        }));
      }
      diagnostics.push(...await validateChainContextReferences(root, skillDir, profilePath, manifest));
    } catch (error) {
      diagnostics.push(createDoctorDiagnostic({
        id: "runx.skill.profile.invalid",
        severity: "error",
        title: "Skill execution profile is invalid",
        message: error instanceof Error ? error.message : String(error),
        target: {
          kind: "skill",
          ref: skillName,
        },
        location: {
          path: toProjectPath(root, profilePath),
        },
        repairs: [{
          id: "repair_profile",
          kind: "manual",
          confidence: "medium",
          risk: "low",
          requires_human_review: false,
        }],
      }));
    }
  }
  return diagnostics;
}

async function discoverPacketDoctorDiagnostics(root: string): Promise<readonly DoctorDiagnostic[]> {
  const diagnostics: DoctorDiagnostic[] = [];
  const index = await buildLocalPacketIndex(root, { writeCache: true });
  for (const error of index.errors) {
    diagnostics.push(createDoctorDiagnostic({
      id: error.id,
      severity: "error",
      title: error.title,
      message: error.message,
      target: {
        kind: "packet",
        ref: error.ref,
      },
      location: {
        path: error.path,
      },
      evidence: error.evidence,
      repairs: [{
        id: "repair_packet_schema",
        kind: "manual",
        confidence: "medium",
        risk: "low",
        requires_human_review: false,
      }],
    }));
  }
  return diagnostics;
}

interface StepOutputDeclaration {
  readonly packet?: string;
}

async function validateChainContextReferences(
  root: string,
  skillDir: string,
  profilePath: string,
  manifest: ReturnType<typeof validateRunnerManifest>,
): Promise<readonly DoctorDiagnostic[]> {
  const diagnostics: DoctorDiagnostic[] = [];
  for (const runner of Object.values(manifest.runners)) {
    const graph = runner.source.chain;
    if (!graph) {
      continue;
    }
    const warnedMissingSchema = new Set<string>();
    const outputMap = new Map<string, Readonly<Record<string, StepOutputDeclaration>>>();
    for (const step of graph.steps) {
      for (const edge of step.contextEdges) {
        const producerOutputs = outputMap.get(edge.fromStep);
        if (!producerOutputs) {
          diagnostics.push(createDoctorDiagnostic({
            id: "runx.chain.context.producer_missing",
            severity: "error",
            title: "Chain context producer is missing",
            message: `${step.id}.${edge.input} references missing producer step ${edge.fromStep}.`,
            target: { kind: "chain", ref: graph.name, step: step.id },
            location: { path: toProjectPath(root, profilePath), json_pointer: `/runners/${runner.name}/chain/steps/${step.id}/context/${edge.input}` },
            evidence: { reference: `${edge.fromStep}.${edge.output}` },
            repairs: [{ id: "choose_existing_producer", kind: "manual", confidence: "medium", risk: "low", requires_human_review: false }],
          }));
          continue;
        }
        if (Object.keys(producerOutputs).length === 0) {
          continue;
        }
        const [emitName, envelopeSegment, ...packetPath] = edge.output.split(".");
        if (!emitName || !producerOutputs[emitName]) {
          diagnostics.push(createDoctorDiagnostic({
            id: "runx.chain.context.output_missing",
            severity: "error",
            title: "Chain context output is missing",
            message: `${step.id}.${edge.input} references output ${emitName || "(empty)"} from ${edge.fromStep}, but that output is not declared.`,
            target: { kind: "chain", ref: graph.name, step: step.id },
            location: { path: toProjectPath(root, profilePath), json_pointer: `/runners/${runner.name}/chain/steps/${step.id}/context/${edge.input}` },
            evidence: {
              reference: `${edge.fromStep}.${edge.output}`,
              available_outputs: Object.keys(producerOutputs),
            },
            repairs: [{ id: "choose_existing_output", kind: "manual", confidence: "medium", risk: "low", requires_human_review: false }],
          }));
          continue;
        }
        if (envelopeSegment !== "data") {
          diagnostics.push(createDoctorDiagnostic({
            id: "runx.chain.context.data_envelope_skipped",
            severity: "error",
            title: "Chain context skipped artifact data envelope",
            message: `${step.id}.${edge.input} must reference ${edge.fromStep}.${emitName}.data before packet fields.`,
            target: { kind: "chain", ref: graph.name, step: step.id },
            location: { path: toProjectPath(root, profilePath), json_pointer: `/runners/${runner.name}/chain/steps/${step.id}/context/${edge.input}` },
            evidence: {
              reference: `${edge.fromStep}.${edge.output}`,
              expected_prefix: `${edge.fromStep}.${emitName}.data`,
            },
            repairs: [{
              id: "insert_data_segment",
              kind: "edit_yaml",
              confidence: "high",
              risk: "low",
              path: toProjectPath(root, profilePath),
              requires_human_review: false,
            }],
          }));
          continue;
        }
        const packetId = producerOutputs[emitName]?.packet;
        if (!packetId) {
          const warningKey = `${edge.fromStep}.${emitName}`;
          if (!warnedMissingSchema.has(warningKey)) {
            warnedMissingSchema.add(warningKey);
            diagnostics.push(createDoctorDiagnostic({
              id: "runx.chain.context.schema_missing",
              severity: "warning",
              title: "Chain context producer has no packet schema",
              message: `${edge.fromStep}.${emitName} has no packet metadata, so doctor cannot verify packet paths.`,
              target: { kind: "chain", ref: graph.name, step: step.id },
              location: { path: toProjectPath(root, profilePath), json_pointer: `/runners/${runner.name}/chain/steps/${step.id}/context/${edge.input}` },
              evidence: { reference: `${edge.fromStep}.${emitName}.data` },
              repairs: [{ id: "add_output_packet", kind: "edit_yaml", confidence: "medium", risk: "low", path: toProjectPath(root, profilePath), requires_human_review: false }],
            }));
          }
          continue;
        }
        const packetCheck = await validatePacketPath(root, packetId, packetPath);
        if (packetCheck.status === "missing_packet") {
          diagnostics.push(createDoctorDiagnostic({
            id: "runx.packet.ref.missing",
            severity: "error",
            title: "Packet schema is missing",
            message: `Packet ${packetId} referenced by ${edge.fromStep}.${emitName} is not declared in package.json runx.packets.`,
            target: { kind: "packet", ref: packetId },
            location: { path: toProjectPath(root, profilePath), json_pointer: `/runners/${runner.name}/chain/steps/${step.id}/context/${edge.input}` },
            evidence: { reference: `${edge.fromStep}.${edge.output}` },
            repairs: [{ id: "declare_packet_artifact", kind: "manual", confidence: "medium", risk: "low", requires_human_review: false }],
          }));
        } else if (packetCheck.status === "path_invalid") {
          diagnostics.push(createDoctorDiagnostic({
            id: "runx.chain.context.path_invalid",
            severity: "error",
            title: "Chain context packet path is invalid",
            message: `${packetPath.join(".") || "(data)"} does not exist in packet ${packetId}.`,
            target: { kind: "chain", ref: graph.name, step: step.id },
            location: { path: toProjectPath(root, profilePath), json_pointer: `/runners/${runner.name}/chain/steps/${step.id}/context/${edge.input}` },
            evidence: {
              reference: `${edge.fromStep}.${edge.output}`,
              packet: packetId,
              available_properties: packetCheck.available,
            },
            repairs: [{ id: "choose_existing_property", kind: "manual", confidence: "medium", risk: "low", requires_human_review: false }],
          }));
        }
      }
      outputMap.set(step.id, await loadStepOutputDeclarations(root, skillDir, step));
    }
  }
  return diagnostics;
}

async function loadStepOutputDeclarations(
  root: string,
  skillDir: string,
  step: { readonly tool?: string; readonly skill?: string; readonly run?: Readonly<Record<string, unknown>>; readonly runner?: string; readonly artifacts?: Readonly<Record<string, unknown>> },
): Promise<Readonly<Record<string, StepOutputDeclaration>>> {
  if (step.tool) {
    const toolDir = resolveToolDirFromRef(root, step.tool);
    if (!toolDir) {
      return {};
    }
    const raw = JSON.parse(await readFile(path.join(toolDir, "manifest.json"), "utf8")) as unknown;
    if (!isPlainRecord(raw)) return {};
    const output = isPlainRecord(raw.output) ? raw.output : {};
    const packet = readPacketRef(output.packet);
    const wrapAs = typeof output.wrap_as === "string"
      ? output.wrap_as
      : isPlainRecord(raw.runx) && isPlainRecord(raw.runx.artifacts) && typeof raw.runx.artifacts.wrap_as === "string"
        ? raw.runx.artifacts.wrap_as
        : undefined;
    if (wrapAs) {
      return { [wrapAs]: { packet } };
    }
    const namedEmits = isPlainRecord(output.named_emits) ? output.named_emits : undefined;
    if (namedEmits) {
      const outputPackets = isPlainRecord(output.outputs) ? output.outputs : {};
      return Object.fromEntries(Object.keys(namedEmits).map((name) => {
        const declared = outputPackets[name];
        return [name, { packet: readPacketRef(isPlainRecord(declared) ? declared.packet : undefined) ?? packet }];
      }));
    }
    return {};
  }
  if (step.skill) {
    const profilePath = resolveNestedSkillProfilePath(skillDir, step.skill);
    if (!profilePath) {
      return {};
    }
    const manifest = validateRunnerManifest(parseRunnerManifestYaml(await readFile(profilePath, "utf8")));
    const runner = step.runner ? manifest.runners[step.runner] : Object.values(manifest.runners).find((candidate) => candidate.default) ?? Object.values(manifest.runners)[0];
    if (!runner) {
      return {};
    }
    return outputDeclarationsFromArtifacts(runner.artifacts, runner.raw);
  }
  return outputDeclarationsFromArtifacts(
    step.artifacts ? {
      wrapAs: typeof step.artifacts.wrap_as === "string" ? step.artifacts.wrap_as : undefined,
      namedEmits: isPlainRecord(step.artifacts.named_emits) ? step.artifacts.named_emits as Readonly<Record<string, string>> : undefined,
    } : undefined,
    { ...(step.run ?? {}), artifacts: step.artifacts },
  );
}

function outputDeclarationsFromArtifacts(
  artifacts: { readonly wrapAs?: string; readonly namedEmits?: Readonly<Record<string, string>> } | undefined,
  raw: Readonly<Record<string, unknown>>,
): Readonly<Record<string, StepOutputDeclaration>> {
  const outputs = isPlainRecord(raw.outputs) ? raw.outputs : {};
  const artifactMetadata = isPlainRecord(raw.artifacts) ? raw.artifacts : {};
  const artifactPackets = isPlainRecord(artifactMetadata.packets) ? artifactMetadata.packets : {};
  if (artifacts?.wrapAs) {
    const output = outputs[artifacts.wrapAs];
    return {
      [artifacts.wrapAs]: {
        packet:
          readPacketRef(isPlainRecord(output) ? output.packet : undefined)
          ?? readPacketRef(artifactMetadata.packet)
          ?? readPacketRef(artifactPackets[artifacts.wrapAs]),
      },
    };
  }
  if (artifacts?.namedEmits) {
    return Object.fromEntries(
      Object.keys(artifacts.namedEmits).map((name) => [
        name,
        {
          packet:
            readPacketRef(isPlainRecord(outputs[name]) ? outputs[name].packet : undefined)
            ?? readPacketRef(artifactPackets[name]),
        },
      ]),
    );
  }
  return {};
}

function resolveNestedSkillProfilePath(skillDir: string, ref: string): string | undefined {
  const resolved = path.resolve(skillDir, ref);
  const directory = path.basename(resolved).toLowerCase() === "skill.md" ? path.dirname(resolved) : resolved;
  const profilePath = path.join(directory, "X.yaml");
  return existsSync(profilePath) ? profilePath : undefined;
}

function readPacketRef(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (isPlainRecord(value) && typeof value.id === "string") {
    return value.id;
  }
  return undefined;
}

async function validatePacketPath(
  root: string,
  packetId: string,
  packetPath: readonly string[],
): Promise<{ readonly status: "ok" } | { readonly status: "missing_packet" } | { readonly status: "path_invalid"; readonly available: readonly string[] }> {
  const index = await buildLocalPacketIndex(root, { writeCache: false });
  const packet = index.packets.find((candidate) => candidate.id === packetId);
  if (!packet) {
    return { status: "missing_packet" };
  }
  const schema = JSON.parse(await readFile(path.resolve(root, packet.path), "utf8")) as unknown;
  const result = schemaHasPath(schema, packetPath, schema);
  return result.ok ? { status: "ok" } : { status: "path_invalid", available: result.available };
}

function schemaHasPath(
  schema: unknown,
  packetPath: readonly string[],
  rootSchema: unknown,
): { readonly ok: boolean; readonly available: readonly string[] } {
  const resolved = resolveJsonSchemaRef(schema, rootSchema);
  if (packetPath.length === 0) {
    return { ok: true, available: [] };
  }
  if (!isPlainRecord(resolved)) {
    return { ok: false, available: [] };
  }
  if (Array.isArray(resolved.anyOf) || Array.isArray(resolved.oneOf)) {
    const branches = (Array.isArray(resolved.anyOf) ? resolved.anyOf : resolved.oneOf) as readonly unknown[];
    const results = branches.map((branch) => schemaHasPath(branch, packetPath, rootSchema));
    return results.some((result) => result.ok) ? { ok: true, available: [] } : results[0] ?? { ok: false, available: [] };
  }
  if (Array.isArray(resolved.allOf)) {
    const results = resolved.allOf.map((branch) => schemaHasPath(branch, packetPath, rootSchema));
    return results.some((result) => result.ok) ? { ok: true, available: [] } : results[0] ?? { ok: false, available: [] };
  }
  if (resolved.type === "array" && resolved.items !== undefined) {
    const [, ...rest] = /^\d+$/.test(packetPath[0] ?? "") ? packetPath : ["", ...packetPath];
    return schemaHasPath(resolved.items, rest, rootSchema);
  }
  const properties = isPlainRecord(resolved.properties) ? resolved.properties : {};
  const [head, ...rest] = packetPath;
  if (!head || !(head in properties)) {
    return { ok: false, available: Object.keys(properties) };
  }
  return schemaHasPath(properties[head], rest, rootSchema);
}

function resolveJsonSchemaRef(schema: unknown, rootSchema: unknown): unknown {
  if (!isPlainRecord(schema) || typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) {
    return schema;
  }
  return schema.$ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((value, segment) => isPlainRecord(value) ? value[segment] : undefined, rootSchema) ?? schema;
}

function createDoctorDiagnostic(
  diagnostic: Omit<DoctorDiagnostic, "instance_id">,
): DoctorDiagnostic {
  return {
    ...diagnostic,
    instance_id: `sha256:${createHash("sha256").update(JSON.stringify({
      id: diagnostic.id,
      target: diagnostic.target,
      location: diagnostic.location,
      evidence: diagnostic.evidence,
    })).digest("hex")}`,
  };
}

function renderDoctorResult(result: DoctorReport, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(process.stdout, env);
  const lines = [
    "",
    `  ${statusIcon(result.status, t)}  ${t.bold}doctor${t.reset}  ${t.dim}${result.summary.errors} error(s), ${result.summary.warnings} warning(s)${t.reset}`,
  ];
  for (const diagnostic of result.diagnostics) {
    lines.push(`  ${statusIcon(diagnostic.severity === "error" ? "failure" : "unverified", t)}  ${diagnostic.id}  ${t.dim}${diagnostic.location.path}${t.reset}`);
    lines.push(`     ${diagnostic.message}`);
  }
  lines.push("");
  return lines.join("\n");
}

const DOCTOR_DIAGNOSTIC_EXPLANATIONS: Readonly<Record<string, {
  readonly title: string;
  readonly severity: "error" | "warning" | "info";
  readonly explanation: string;
  readonly repair: string;
}>> = {
  "runx.tool.manifest.legacy_format": {
    title: "Legacy tool.yaml is no longer supported",
    severity: "error",
    explanation: "Runx v1 resolves tools from manifest.json generated or normalized by the authoring pipeline. A remaining tool.yaml means there are two potential sources of truth.",
    repair: "Run runx tool migrate <tool-dir>, review the generated manifest.json and run.mjs, then re-run runx doctor.",
  },
  "runx.tool.manifest.invalid": {
    title: "Tool manifest is invalid",
    severity: "error",
    explanation: "The resolver could not validate manifest.json, so the tool is not safe to list, compose, or execute.",
    repair: "Repair the manifest or rebuild it from src/index.ts with runx tool build <tool-dir>.",
  },
  "runx.tool.manifest.build_failed": {
    title: "Tool build failed",
    severity: "error",
    explanation: "The dev loop runs tool build before fixtures so generated manifests and shims are fresh.",
    repair: "Run the reported command manually, fix the tool source or manifest, then re-run runx dev.",
  },
  "runx.tool.manifest.stale": {
    title: "Tool manifest is stale",
    severity: "error",
    explanation: "manifest.json is the checked-in runtime contract. Its hashes must match the source and schema fields reviewers see in the same PR.",
    repair: "Run runx tool build <tool-dir> and commit the regenerated manifest.",
  },
  "runx.tool.fixture.missing": {
    title: "Tool has no deterministic fixture",
    severity: "error",
    explanation: "Every first-party tool needs at least one repo-visible deterministic fixture so humans and agents can see how to invoke it and runx dev can prove it still works.",
    repair: "Add tools/<namespace>/<name>/fixtures/<case>.yaml with target.kind: tool, inputs, and an output assertion.",
  },
  "runx.skill.profile.invalid": {
    title: "Skill execution profile is invalid",
    severity: "error",
    explanation: "X.yaml is the runx execution profile layered on top of SKILL.md. The X stands for execution. If it does not validate, runx cannot reliably compose the skill.",
    repair: "Fix the YAML and schema error reported by doctor.",
  },
  "runx.skill.fixture.missing": {
    title: "Skill has no harness coverage",
    severity: "error",
    explanation: "A runx-extended skill needs at least one executable example. Inline harness.cases in X.yaml and fixture files both count because they give humans and agents a replayable contract.",
    repair: "Add a focused harness.cases entry or a fixture that proves the intended success or stop condition, then re-run runx harness and runx doctor.",
  },
  "runx.chain.context.path_invalid": {
    title: "Chain context path is invalid",
    severity: "error",
    explanation: "A chain context reference points at a producer output path that does not exist according to the producer packet schema.",
    repair: "Use the producer step id, emitted output name, mandatory data segment, and a valid property inside the packet.",
  },
  "runx.chain.context.schema_missing": {
    title: "Chain context producer has no packet schema",
    severity: "warning",
    explanation: "Doctor can verify topology but cannot type-check the referenced data path without a declared packet schema.",
    repair: "Add artifacts.packet for a single emitted artifact, artifacts.packets.<emit> for named emits, or output.packet metadata for tools.",
  },
  "runx.packet.ref.missing": {
    title: "Packet glob matched no files",
    severity: "error",
    explanation: "package.json runx.packets declares packet artifacts that do not exist, so packet assertions and chain validation cannot resolve them.",
    repair: "Fix the glob or build the packet artifacts.",
  },
  "runx.packet.id.collision": {
    title: "Packet ID collision",
    severity: "error",
    explanation: "Two schemas declare the same immutable packet id with different canonical hashes.",
    repair: "Rename one packet id or bump the version segment.",
  },
};

function listDoctorDiagnostics(): Readonly<Record<string, unknown>> {
  return {
    schema: "runx.doctor.diagnostics.v1",
    diagnostics: Object.entries(DOCTOR_DIAGNOSTIC_EXPLANATIONS).map(([id, value]) => ({ id, ...value })),
  };
}

function explainDoctorDiagnostic(id: string): Readonly<Record<string, unknown>> {
  const diagnostic = DOCTOR_DIAGNOSTIC_EXPLANATIONS[id];
  return diagnostic
    ? { schema: "runx.doctor.explain.v1", status: "success", id, ...diagnostic }
    : { schema: "runx.doctor.explain.v1", status: "failure", id, message: `Unknown diagnostic id ${id}.` };
}

function renderDoctorDiagnosticList(result: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(process.stdout, env);
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics.filter(isPlainRecord) : [];
  const lines = ["", `  ${t.bold}doctor diagnostics${t.reset}  ${t.dim}${diagnostics.length} known${t.reset}`];
  for (const diagnostic of diagnostics) {
    lines.push(`  ${String(diagnostic.id).padEnd(42)} ${t.dim}${String(diagnostic.severity)}${t.reset}  ${String(diagnostic.title)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderDoctorDiagnosticExplanation(result: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(process.stdout, env);
  if (result.status !== "success") {
    return `\n  ${statusIcon("failure", t)}  ${String(result.message)}\n\n`;
  }
  return renderKeyValue(
    String(result.id),
    "success",
    [
      ["severity", String(result.severity)],
      ["title", String(result.title)],
      ["why", String(result.explanation)],
      ["repair", String(result.repair)],
    ],
    t,
  );
}

function renderListResult(result: RunxListReport, env: NodeJS.ProcessEnv = process.env): string {
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

function parseJsonMaybe(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function normalizeKnownFlag(rawKey: string): string {
  return rawKey.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

async function resolveResumeSkillPath(
  runId: string,
  receiptDir: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const entries = await readLedgerEntries(receiptDir ? resolvePathFromUserInput(receiptDir, env) : resolveDefaultReceiptDir(env), runId);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "run_event") {
      continue;
    }
    const data = isRecord(entry.data) ? entry.data : undefined;
    const kind = typeof data?.kind === "string" ? data.kind : undefined;
    const detail = isRecord(data?.detail) ? data.detail : undefined;
    if (kind !== "resolution_requested" || typeof detail?.skill_path !== "string") {
      continue;
    }
    return detail.skill_path;
  }
  throw new Error(`Run '${runId}' cannot be resumed because no pending skill path was recorded.`);
}

function resolveConfiguredConnectService(env: NodeJS.ProcessEnv): ConnectService | undefined {
  const baseUrl = env.RUNX_CONNECT_BASE_URL;
  const accessToken = env.RUNX_CONNECT_ACCESS_TOKEN;

  if (!baseUrl || !accessToken) {
    return undefined;
  }

  return createHttpConnectService({
    baseUrl,
    accessToken,
    openCommand: env.RUNX_CONNECT_OPEN_COMMAND,
    pollIntervalMs: parseOptionalInt(env.RUNX_CONNECT_POLL_INTERVAL_MS),
    timeoutMs: parseOptionalInt(env.RUNX_CONNECT_TIMEOUT_MS),
    env,
  });
}

function normalizeDigest(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function normalizeScopes(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === "string" && scope.length > 0).flatMap(splitScopes);
  }
  if (typeof value === "string" && value !== "true") {
    return splitScopes(value);
  }
  return [];
}

function normalizeAuthorityKind(value: unknown): ParsedArgs["connectAuthorityKind"] {
  return value === "read_only" || value === "constructive" || value === "destructive" ? value : undefined;
}

function splitScopes(value: string): readonly string[] {
  return value
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

function connectAction(positionals: readonly string[]): ParsedArgs["connectAction"] {
  if (positionals[0] === "list") {
    return "list";
  }
  if (positionals[0] === "revoke") {
    return "revoke";
  }
  return positionals[0] ? "preprovision" : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function renderConfigResult(result: ConfigResult, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(undefined, env);
  if (result.action === "list") {
    const entries = flattenConfig(result.values);
    if (entries.length === 0) return `\n  ${t.dim}No config values set.${t.reset}\n\n`;
    return renderKeyValue("config", "success", entries, t);
  }
  const value = String(result.value ?? "");
  return renderKeyValue("config", "success", [[result.key, value]], t);
}

function renderNewResult(result: NewResult, env: NodeJS.ProcessEnv = process.env): string {
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

function renderInitResult(result: InitResult, env: NodeJS.ProcessEnv = process.env): string {
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

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function renderSearchResults(results: readonly SkillSearchResult[], env: NodeJS.ProcessEnv = process.env): string {
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

function renderReceiptInspection(summary: LocalReceiptSummary, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(undefined, env);
  const rows: Array<[string, string]> = [
    ["id", summary.id],
    ["kind", summary.kind],
    ["status", summary.status],
  ];
  if (summary.sourceType) rows.push(["source", summary.sourceType]);
  if (summary.startedAt) rows.push(["started", relativeTime(summary.startedAt)]);
  if (summary.completedAt) rows.push(["completed", relativeTime(summary.completedAt)]);
  if (summary.verification) rows.push(["verify", `${summary.verification.status}${summary.verification.reason ? ` (${summary.verification.reason})` : ""}`]);
  rows.push(["history", "runx history"]);
  rows.push(["json", `runx inspect ${summary.id} --json`]);
  return renderKeyValue(summary.name, summary.status, rows, t);
}

function renderHistory(
  receipts: readonly LocalReceiptSummary[],
  env: NodeJS.ProcessEnv = process.env,
  query?: string,
): string {
  const t = theme(undefined, env);
  if (receipts.length === 0) {
    return query
      ? `\n  ${t.dim}No receipts matched ${t.cyan}${query}${t.reset}${t.dim}.${t.reset}\n  ${t.dim}Try ${t.cyan}runx history${t.reset}${t.dim} to see every local run.${t.reset}\n\n`
      : `\n  ${t.dim}No receipts yet. Try a run first:${t.reset}\n  ${t.cyan}runx evolve${t.reset}\n  ${t.cyan}runx search docs${t.reset}\n\n`;
  }
  const now = Date.now();
  const nameWidth = Math.min(32, Math.max(...receipts.map((r) => r.name.length)));
  const lines: string[] = [""];
  lines.push(`  ${t.bold}history${t.reset}${query ? `  ${t.dim}· ${query}${t.reset}` : ""}  ${t.dim}${receipts.length} receipt(s)${t.reset}`);
  lines.push("");
  for (const summary of receipts) {
    const icon = statusIcon(summary.status, t);
    const name = summary.name.padEnd(nameWidth);
    const when = summary.startedAt ? relativeTime(summary.startedAt, now) : "";
    const source = summary.sourceType ?? summary.kind;
    const id = shortId(summary.id);
    const verification = summary.verification?.status ?? "unknown";
    lines.push(
      `  ${icon}  ${t.bold}${name}${t.reset}  ${t.dim}${source.padEnd(16)}${t.reset}  ${t.dim}${verification.padEnd(10)}${t.reset}  ${t.dim}${when.padEnd(10)}${t.reset}  ${t.dim}${id}${t.reset}`,
    );
  }
  lines.push("");
  lines.push(`  ${t.dim}next${t.reset}  runx inspect <receipt-id>`);
  lines.push("");
  return lines.join("\n");
}

function renderVerificationBadge(verification: LocalReceiptSummary["verification"] | undefined, t: UiTheme): string {
  if (!verification) return "";
  const color = verification.status === "verified" ? t.green : verification.status === "invalid" ? t.red : t.dim;
  const reason = verification.reason ? ` ${t.dim}(${verification.reason})${t.reset}` : "";
  return `  ${color}${verification.status}${t.reset}${reason}`;
}

function renderKnowledgeProjections(
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
    lines.push(
      `  ${t.bold}${projection.key.padEnd(keyWidth)}${t.reset}  ${value}  ${t.dim}· ${projection.scope}/${projection.source} ${projection.freshness}${t.reset}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderInstallResult(
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

function renderPublishResult(
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

function renderConnectResult(
  action: "list" | "revoke" | "preprovision",
  result: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const t = theme(undefined, env);
  if (action === "list") {
    const grants = isRecord(result) && Array.isArray(result.grants) ? result.grants.filter(isRecord) : [];
    if (grants.length === 0) {
      return `\n  ${t.dim}No connections yet.${t.reset}\n  ${t.dim}start${t.reset}  runx connect github\n\n`;
    }
    const lines = ["", `  ${t.bold}connections${t.reset}  ${t.dim}${grants.length} grant(s)${t.reset}`, ""];
    for (const grant of grants) {
      const grantId = typeof grant.grant_id === "string" ? grant.grant_id : "unknown";
      const provider = typeof grant.provider === "string" ? grant.provider : "unknown";
      const scopes = Array.isArray(grant.scopes) ? grant.scopes.join(", ") : "";
      const scopeFamily = typeof grant.scope_family === "string" ? grant.scope_family : "";
      const authorityKind = typeof grant.authority_kind === "string" ? grant.authority_kind : "";
      const targetRepo = typeof grant.target_repo === "string" ? grant.target_repo : "";
      const targetLocator = typeof grant.target_locator === "string" ? grant.target_locator : "";
      const status = typeof grant.status === "string" ? grant.status : "active";
      lines.push(`  ${statusIcon(status === "revoked" ? "failure" : "success", t)}  ${t.bold}${provider}${t.reset}  ${t.dim}${grantId}${t.reset}`);
      if (scopes) lines.push(`  ${t.dim}scopes${t.reset}  ${scopes}`);
      if (scopeFamily) lines.push(`  ${t.dim}family${t.reset}  ${scopeFamily}`);
      if (authorityKind) lines.push(`  ${t.dim}authority${t.reset}  ${authorityKind}`);
      if (targetRepo) lines.push(`  ${t.dim}repo${t.reset}  ${targetRepo}`);
      if (targetLocator) lines.push(`  ${t.dim}locator${t.reset}  ${targetLocator}`);
      lines.push("");
    }
    return lines.join("\n");
  }
  const grant = isRecord(result) && isRecord(result.grant) ? result.grant : undefined;
  const provider = typeof grant?.provider === "string" ? grant.provider : undefined;
  const grantId = typeof grant?.grant_id === "string" ? grant.grant_id : undefined;
  const scopes = Array.isArray(grant?.scopes) ? grant.scopes.join(", ") : undefined;
  const scopeFamily = typeof grant?.scope_family === "string" ? grant.scope_family : undefined;
  const authorityKind = typeof grant?.authority_kind === "string" ? grant.authority_kind : undefined;
  const targetRepo = typeof grant?.target_repo === "string" ? grant.target_repo : undefined;
  const targetLocator = typeof grant?.target_locator === "string" ? grant.target_locator : undefined;
  const status = isRecord(result) && typeof result.status === "string" ? result.status : "success";
  return renderKeyValue(
    action === "revoke" ? "connection revoked" : "connection ready",
    status === "revoked" || status === "created" || status === "unchanged" ? "success" : status,
    [
      ["provider", provider],
      ["grant", grantId],
      ["scopes", scopes],
      ["family", scopeFamily],
      ["authority", authorityKind],
      ["repo", targetRepo],
      ["locator", targetLocator],
      ["next", action === "revoke" ? "runx connect github" : "runx connect list"],
    ],
    t,
  );
}

function resolveKnowledgeDir(env: NodeJS.ProcessEnv): string {
  return resolveRunxKnowledgeDir(env);
}

function resolveRunxDir(env: NodeJS.ProcessEnv): string {
  return resolveRunxHomeDir(env);
}

function resolveDefaultReceiptDir(env: NodeJS.ProcessEnv): string {
  return path.resolve(
    env.RUNX_RECEIPT_DIR ?? env.INIT_CWD ?? env.RUNX_CWD ?? process.cwd(),
    ".runx",
    "receipts",
  );
}

function createNonInteractiveCaller(
  answers: Readonly<Record<string, unknown>> = {},
  approvals?: boolean | Readonly<Record<string, boolean>>,
  loadAgentRuntime?: () => Promise<CliAgentRuntime | undefined>,
): Caller {
  return {
    resolve: async (request) => resolveNonInteractiveRequest(request, answers, approvals, loadAgentRuntime),
    report: () => undefined,
  };
}

function createInteractiveCaller(
  io: CliIo,
  answers: Readonly<Record<string, unknown>> = {},
  approvals?: boolean | Readonly<Record<string, boolean>>,
  options: { readonly reportEvents?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
  loadAgentRuntime?: () => Promise<CliAgentRuntime | undefined>,
): Caller {
  return {
    resolve: async (request) => resolveInteractiveRequest(request, io, answers, approvals, loadAgentRuntime),
    report: (event) => {
      if (options.reportEvents === false) {
        return;
      }
      const rendered = renderExecutionEvent(event, io, env);
      if (rendered) {
        io.stdout.write(rendered);
      }
    },
  };
}

async function approveGate(
  gate: { readonly id: string; readonly reason: string },
  io: CliIo,
  approvals?: boolean | Readonly<Record<string, boolean>>,
): Promise<boolean> {
  const provided = resolveApproval(gate.id, approvals);
  if (provided !== undefined) {
    return provided;
  }

  const rl = createInterface({
    input: io.stdin,
    output: io.stdout,
  });
  const t = theme(io.stdout);

  try {
    io.stdout.write(`\n  ${t.yellow}◆${t.reset}  ${t.bold}approval needed${t.reset}\n`);
    io.stdout.write(`  ${t.dim}gate${t.reset}    ${gate.id}\n`);
    io.stdout.write(`  ${t.dim}reason${t.reset}  ${gate.reason}\n\n`);
    const answer = (await rl.question(`  ${t.cyan}›${t.reset} Approve? [y/N] `)).trim().toLowerCase();
    io.stdout.write("\n");
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function resolveNonInteractiveRequest(
  request: ResolutionRequest,
  answers: Readonly<Record<string, unknown>> = {},
  approvals?: boolean | Readonly<Record<string, boolean>>,
  loadAgentRuntime?: () => Promise<CliAgentRuntime | undefined>,
): Promise<ResolutionResponse | undefined> {
  if (request.kind === "input") {
    const payload = pickAnswers(request.questions, answers);
    return Object.keys(payload).length === 0 ? undefined : { actor: "human", payload };
  }
  if (request.kind === "approval") {
    const approved = resolveApproval(request.gate.id, approvals);
    return approved === undefined ? undefined : { actor: "human", payload: approved };
  }
  const payload = answers[request.id];
  if (payload !== undefined) {
    return { actor: "agent", payload };
  }
  const agentRuntime = loadAgentRuntime ? await loadAgentRuntime() : undefined;
  return agentRuntime ? await agentRuntime.resolve(request) : undefined;
}

async function resolveInteractiveRequest(
  request: ResolutionRequest,
  io: CliIo,
  answers: Readonly<Record<string, unknown>> = {},
  approvals?: boolean | Readonly<Record<string, boolean>>,
  loadAgentRuntime?: () => Promise<CliAgentRuntime | undefined>,
): Promise<ResolutionResponse | undefined> {
  if (request.kind === "input") {
    return {
      actor: "human",
      payload: await askQuestions(request.questions, io, answers),
    };
  }
  if (request.kind === "approval") {
    const provided = resolveApproval(request.gate.id, approvals);
    return {
      actor: "human",
      payload: provided ?? await approveGate(request.gate, io, approvals),
    };
  }
  const payload = answers[request.id];
  if (payload !== undefined) {
    return { actor: "agent", payload };
  }
  const agentRuntime = loadAgentRuntime ? await loadAgentRuntime() : undefined;
  return agentRuntime ? await agentRuntime.resolve(request) : undefined;
}

function createAgentRuntimeLoader(
  env: NodeJS.ProcessEnv,
): () => Promise<CliAgentRuntime | undefined> {
  let runtimePromise: Promise<CliAgentRuntime | undefined> | undefined;
  return async () => {
    runtimePromise ??= loadCliAgentRuntime(env);
    return await runtimePromise;
  };
}

function resolveApproval(
  gateId: string,
  approvals?: boolean | Readonly<Record<string, boolean>>,
): boolean | undefined {
  if (typeof approvals === "boolean") {
    return approvals;
  }
  return approvals?.[gateId];
}

async function askQuestions(
  questions: readonly Question[],
  io: CliIo,
  answers: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const provided = pickAnswers(questions, answers);
  const autoFilled = Object.fromEntries(
    questions
      .filter((question) => provided[question.id] === undefined && shouldAutoUseDefault(question))
      .map((question) => [question.id, inferQuestionDefault(question)])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
  const seeded = { ...provided, ...autoFilled };
  const unanswered = questions.filter((question) => seeded[question.id] === undefined);
  if (unanswered.length === 0) {
    return seeded;
  }

  const t = theme(io.stdout);
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  const countLabel = unanswered.length === 1 ? "1 value" : `${unanswered.length} values`;
  io.stdout.write(`\n  ${t.yellow}◇${t.reset}  ${t.bold}input needed${t.reset}  ${t.dim}${countLabel}${t.reset}\n\n`);

  try {
    const collected: Record<string, unknown> = { ...seeded };
    for (const question of unanswered) {
      const defaultValue = inferQuestionDefault(question);
      const label = question.prompt;
      const detail = question.description && question.description !== question.prompt ? question.description : undefined;
      io.stdout.write(`  ${t.bold}${label}${t.reset}\n`);
      if (detail) {
        io.stdout.write(`  ${t.dim}${detail}${t.reset}\n`);
      }
      if (defaultValue) {
        io.stdout.write(`  ${t.dim}default${t.reset}  ${defaultValue}\n`);
      } else if (question.required) {
        io.stdout.write(`  ${t.dim}required${t.reset}\n`);
      }
      const answer = (await rl.question(`  ${t.cyan}›${t.reset} `)).trim();
      collected[question.id] = answer || defaultValue || "";
      io.stdout.write("\n");
    }
    return collected;
  } finally {
    rl.close();
  }
}

function inferQuestionDefault(question: Question): string | undefined {
  const label = `${question.id} ${question.prompt} ${question.description ?? ""}`.toLowerCase();
  if (question.id === "project" || /project\s+root|repo\s+root|working\s+directory/.test(label)) {
    return process.cwd();
  }
  return undefined;
}

function shouldAutoUseDefault(question: Question): boolean {
  const label = `${question.id} ${question.prompt} ${question.description ?? ""}`.toLowerCase();
  return question.id === "project" || /project\s+root|repo\s+root|working\s+directory/.test(label);
}

function pickAnswers(
  questions: readonly Question[],
  answers: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    questions
      .filter((question) => answers[question.id] !== undefined)
      .map((question) => [question.id, answers[question.id]]),
  );
}

async function readCallerInputFile(answersPath: string): Promise<CallerInputFile> {
  const parsed = JSON.parse(await readFile(answersPath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("--answers file must contain a JSON object.");
  }
  if (parsed.answers === undefined && parsed.approvals === undefined) {
    return {
      answers: parsed,
    };
  }
  if (parsed.answers !== undefined && !isRecord(parsed.answers)) {
    throw new Error("--answers answers field must be an object.");
  }
  return {
    answers: parsed.answers === undefined ? {} : parsed.answers,
    approvals: validateCallerApprovals(parsed.approvals),
  };
}

function validateCallerApprovals(value: unknown): boolean | Readonly<Record<string, boolean>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (!isRecord(value)) {
    throw new Error("--answers approvals field must be a boolean or object.");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, approval]) => {
      if (typeof approval !== "boolean") {
        throw new Error(`--answers approvals.${key} must be a boolean.`);
      }
      return [key, approval];
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const exitCode = await runCli(process.argv.slice(2), {
    stdin: processStdin,
    stdout: processStdout,
    stderr: process.stderr,
  });
  process.exitCode = exitCode;
}
