#!/usr/bin/env node

export const cliPackage = "@runxhq/cli";

import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
import {
  createDefaultHttpCachedRegistryStore,
  createFileRegistryStore,
  createLocalRegistryClient,
  publishSkillMarkdown,
  type RegistryStore,
} from "@runxhq/core/registry";
import {
  installLocalSkill,
  runLocalSkill,
  type Caller,
  type ExecutionEvent,
  type RunLocalSkillResult,
} from "@runxhq/core/runner-local";
import type { ApprovalGate, Question, ResolutionRequest, ResolutionResponse } from "@runxhq/core/executor";
import { loadCliAgentRuntime, type CliAgentRuntime } from "./agent-runtime.js";
import {
  buildLocalPacketIndex,
  stableStringify,
  toProjectPath,
} from "./authoring-utils.js";
import { configAction, flattenConfig, handleConfigCommand, type ConfigResult } from "./commands/config.js";
import {
  handleDevCommand,
  renderDevResult,
} from "./commands/dev.js";
import {
  handleConnectCommand,
  normalizeConnectAuthorityKind,
  parseConnectAction,
  renderConnectResult,
  resolveConfiguredConnectService,
  type ConnectAuthorityKind,
  type ConnectService,
} from "./commands/connect.js";
import {
  explainDoctorDiagnostic,
  handleDoctorCommand,
  listDoctorDiagnostics,
  renderDoctorDiagnosticExplanation,
  renderDoctorDiagnosticList,
  renderDoctorResult,
} from "./commands/doctor.js";
import {
  handleHistoryCommand,
  handleInspectCommand,
  renderHistory,
  renderReceiptInspection,
} from "./commands/history.js";
import { handleInitCommand, type InitResult } from "./commands/init.js";
import {
  handleListCommand,
  normalizeListKind,
  type RunxListItem,
  type RunxListReport,
  type RunxListRequestedKind,
} from "./commands/list.js";
import { handleNewCommand, type NewResult } from "./commands/new.js";
import {
  handleToolBuildCommand,
  handleToolMigrateCommand,
  renderToolCommandResult,
} from "./commands/tool.js";
import { ensureRunxInstallState } from "./runx-state.js";
import {
  preferredRunCommand,
  resolveRunnableSkillReference,
  runSkillSearch,
} from "./skill-refs.js";
export { resolveSkillReference, resolveRunnableSkillReference } from "./skill-refs.js";
import { streamTrainableReceipts } from "./trainable-receipts.js";
import { renderKeyValue, relativeTime, shortId, statusIcon, theme, type UiTheme } from "./ui.js";

export interface CliIo {
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
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

interface CallerInputFile {
  readonly answers: Readonly<Record<string, unknown>>;
  readonly approvals?: boolean | Readonly<Record<string, boolean>>;
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
  readonly connectAuthorityKind?: ConnectAuthorityKind;
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
      const result = await handleDevCommand(parsed, env, {
        resolveRegistryStoreForChains,
        resolveDefaultReceiptDir,
        createNonInteractiveCaller,
        createAgentRuntimeLoader,
      });
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
      const result = await handleConnectCommand({
        connectAction: parsed.connectAction,
        connectProvider: parsed.connectProvider,
        connectGrantId: parsed.connectGrantId,
        connectScopes: parsed.connectScopes,
        connectScopeFamily: parsed.connectScopeFamily,
        connectAuthorityKind: parsed.connectAuthorityKind,
        connectTargetRepo: parsed.connectTargetRepo,
        connectTargetLocator: parsed.connectTargetLocator,
      }, connectService);
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
      const inspection = await handleInspectCommand({
        receiptId: parsed.receiptId,
        receiptDir: parsed.receiptDir,
      }, env);
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
      } else {
        io.stdout.write(renderReceiptInspection(inspection.summary, env));
      }
      return 0;
    }

    if (parsed.command === "history") {
      const history = await handleHistoryCommand(parsed, env);
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
  const connectAuthorityKind = isConnect ? normalizeConnectAuthorityKind(connectAuthoritySource) : undefined;
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
    connectAction: isConnect ? parseConnectAction(positionals) : undefined,
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

function splitScopes(value: string): readonly string[] {
  return value
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
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
