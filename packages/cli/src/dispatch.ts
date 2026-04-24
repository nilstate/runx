import path from "node:path";

import { createDefaultSkillAdapters, resolveDefaultSkillAdapters } from "@runxhq/adapters";
import {
  isRemoteRegistryUrl,
  loadLocalSkillPackage,
  resolvePathFromUserInput,
  resolveRunxGlobalHomeDir,
  resolveRunxKnowledgeDir,
  resolveRunxRegistryPath,
  resolveRunxRegistryTarget,
  resolveSkillInstallRoot,
} from "@runxhq/core/config";
import { runHarnessTarget, validatePublishHarness } from "@runxhq/core/harness";
import { createFixtureMarketplaceAdapter } from "@runxhq/core/marketplaces";
import { createFileKnowledgeStore } from "@runxhq/core/knowledge";
import { resolveEnvToolCatalogAdapters, searchToolCatalogAdapters } from "@runxhq/core/tool-catalogs";
import {
  createDefaultHttpCachedRegistryStore,
  createFileRegistryStore,
  createLocalRegistryClient,
  publishSkillMarkdown,
  type RegistryStore,
} from "@runxhq/core/registry";
import {
  installLocalSkill,
  readPendingSkillPath,
  runLocalSkill,
  type Caller,
  type RunLocalSkillResult,
} from "@runxhq/core/runner-local";

import type { CliIo, CliServices, ParsedArgs } from "./index.js";
import { createAgentRuntimeLoader, createNonInteractiveCaller } from "./callers.js";
import {
  renderCliError,
  renderConfigResult,
  renderHarnessResult,
  renderInitResult,
  renderInstallResult,
  renderKnowledgeProjections,
  renderListResult,
  renderNewResult,
  renderPublishResult,
  renderSearchResults,
  renderToolSearchResults,
  writeLocalSkillResult,
} from "./cli-presentation.js";
import { handleConfigCommand } from "./commands/config.js";
import {
  handleConnectCommand,
  renderConnectResult,
  resolveConfiguredConnectService,
} from "./commands/connect.js";
import { handleDevCommand, renderDevResult } from "./commands/dev.js";
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
import { handleInitCommand } from "./commands/init.js";
import { handleListCommand } from "./commands/list.js";
import { handleMcpServeCommand } from "./commands/mcp.js";
import { handleNewCommand } from "./commands/new.js";
import {
  handleToolBuildCommand,
  handleToolMigrateCommand,
  renderToolCommandResult,
  type ToolCommandArgs,
} from "./commands/tool.js";
import { ensureRunxInstallState } from "./runx-state.js";
import { resolveBundledCliVoiceProfilePath } from "./runtime-assets.js";
import { resolveRunnableSkillReference, runSkillSearch } from "./skill-refs.js";
import { streamTrainableReceipts } from "./trainable-receipts.js";

export async function dispatchCli(
  parsed: ParsedArgs,
  io: CliIo,
  env: NodeJS.ProcessEnv,
  caller: Caller,
  services: CliServices = {},
): Promise<number> {
  const connectService = parsed.command === "connect" ? services.connect ?? resolveConfiguredConnectService(env) : services.connect;

  if (parsed.command === "harness" && parsed.harnessPath) {
    const result = await runHarnessTarget(resolvePathFromUserInput(parsed.harnessPath, env), {
      env,
      registryStore: await resolveRegistryStoreForChains(env),
      toolCatalogAdapters: resolveEnvToolCatalogAdapters(env),
      adapters: createDefaultSkillAdapters(),
      voiceProfilePath: await resolveBundledCliVoiceProfilePath(),
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

  if (parsed.command === "tool" && (parsed.toolAction === "build" || parsed.toolAction === "migrate")) {
    const toolArgs: ToolCommandArgs = {
      toolAction: parsed.toolAction,
      toolPath: parsed.toolPath,
      toolAll: parsed.toolAll,
    };
    const result = toolArgs.toolAction === "build"
      ? await handleToolBuildCommand(toolArgs, env)
      : await handleToolMigrateCommand(toolArgs, env);
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

  if (parsed.command === "mcp" && parsed.mcpAction === "serve") {
    await handleMcpServeCommand(parsed, io, env, {
      resolveRegistryStoreForChains,
      resolveDefaultReceiptDir,
    });
    return 0;
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

  if (parsed.command === "tool" && parsed.toolAction === "search" && parsed.searchQuery) {
    const results = await searchToolCatalogAdapters(
      resolveEnvToolCatalogAdapters(env, parsed.sourceFilter),
      parsed.searchQuery,
    );
    if (parsed.json) {
      io.stdout.write(`${JSON.stringify({
        status: "success",
        query: parsed.searchQuery,
        source: parsed.sourceFilter ?? "all",
        results,
      }, null, 2)}\n`);
    } else {
      io.stdout.write(renderToolSearchResults(results, env));
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
      toolCatalogAdapters: resolveEnvToolCatalogAdapters(env),
      adapters: createDefaultSkillAdapters(),
      voiceProfilePath: await resolveBundledCliVoiceProfilePath(),
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
      io.stdout.write(`${JSON.stringify({
        status: "success",
        query: parsed.historyQuery,
        filters: {
          skill: parsed.historySkill,
          status: parsed.historyStatus,
          source_type: parsed.historySource,
          actor: parsed.historyActor,
          artifact_type: parsed.historyArtifactType,
          since: parsed.historySince,
          until: parsed.historyUntil,
        },
        ...history,
      }, null, 2)}\n`);
    } else {
      io.stdout.write(renderHistory(history.receipts, env, parsed.historyQuery));
    }
    return 0;
  }

  if (parsed.command === "export-receipts" && parsed.exportAction === "trainable") {
    const receiptDir = parsed.receiptDir
      ? resolvePathFromUserInput(parsed.receiptDir, env)
      : resolveDefaultReceiptDir(env);
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
}

export function writeCliError(io: CliIo, message: string): number {
  io.stderr.write(renderCliError(message));
  return 1;
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
  const adapters = await resolveDefaultSkillAdapters(options.env);
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
    adapters,
    toolCatalogAdapters: resolveEnvToolCatalogAdapters(options.env),
    voiceProfilePath: await resolveBundledCliVoiceProfilePath(),
  });
}

function resolveKnowledgeDir(env: NodeJS.ProcessEnv): string {
  return resolveRunxKnowledgeDir(env);
}

function resolveDefaultReceiptDir(env: NodeJS.ProcessEnv): string {
  return path.resolve(
    env.RUNX_RECEIPT_DIR ?? env.INIT_CWD ?? env.RUNX_CWD ?? process.cwd(),
    ".runx",
    "receipts",
  );
}

async function resolveResumeSkillPath(
  runId: string,
  receiptDir: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const skillPath = await readPendingSkillPath(
    receiptDir ? resolvePathFromUserInput(receiptDir, env) : resolveDefaultReceiptDir(env),
    runId,
  );
  if (skillPath) {
    return skillPath;
  }
  throw new Error(`Run '${runId}' cannot be resumed because no pending skill path was recorded.`);
}
