import path from "node:path";

import {
  resolvePathFromUserInput,
  resolveRunxGlobalHomeDir,
  resolveRunxKnowledgeDir,
  resolveRunxRegistryTarget,
  resolveSkillInstallRoot,
} from "./cli-config.js";
import { createFileKnowledgeStore } from "./cli-knowledge.js";
import { arrayValue, firstNonEmpty, isRecord, recordField, stringField } from "./cli-util.js";

import type { ParsedArgs } from "./args.js";
import type { CliIo, CliServices } from "./index.js";
import type {
  CliRuntimeReceipt,
  CliSkillRunResult,
} from "./cli-runtime-contracts.js";
import {
  renderCliError,
  renderConfigResult,
  renderInitResult,
  renderKnowledgeProjections,
  renderListResult,
  renderNewResult,
  renderSearchResults,
  writeLocalSkillResult,
} from "./cli-presentation.js";
import { handleConfigCommand } from "./commands/config.js";
import {
  isGithubRepoUrl,
  publishUrlSkill,
  renderUrlAddResult,
  resolveUrlAddApiBaseUrl,
  UrlAddCliError,
} from "./commands/url-add.js";
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
  renderHistory,
} from "./commands/history.js";
import { handleInitCommand } from "./commands/init.js";
import { handleListCommand } from "./commands/list.js";
import { handleMcpServeCommand } from "./commands/mcp.js";
import { handleNewCommand } from "./commands/new.js";
import {
  handleToolBuildCommand,
  renderToolCommandResult,
  type ToolCommandArgs,
} from "./commands/tool.js";
import { ensureRunxInstallState } from "./runx-state.js";
import { resolveBundledCliToolRoots } from "./runtime-assets.js";
import { runSkillSearch } from "./skill-refs.js";
import { streamTrainableReceipts } from "./trainable-receipts.js";
import { runNativeRunx, streamNativeRunx, type NativeRunxProcessResult } from "./native-runx.js";

export async function dispatchCli(
  parsed: ParsedArgs,
  io: CliIo,
  env: NodeJS.ProcessEnv,
  _services: CliServices = {},
): Promise<number> {
  if (parsed.command === "harness" && parsed.harnessPath) {
    return await streamNativeRunxToIo(io, ["harness", resolvePathFromUserInput(parsed.harnessPath, env), "--json"], env);
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

  if (parsed.command === "tool" && parsed.toolAction === "build") {
    const toolArgs: ToolCommandArgs = {
      toolAction: parsed.toolAction,
      toolPath: parsed.toolPath,
      toolAll: parsed.toolAll,
    };
    const result = await handleToolBuildCommand(toolArgs, env);
    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.stdout.write(renderToolCommandResult(result, env));
    }
    return result.status === "success" ? 0 : 1;
  }

  if (parsed.command === "dev") {
    if (parsed.devRecord || parsed.devRealAgents || parsed.devWatch) {
      throw new Error("native runx dev does not support --record, --real-agents, or --watch yet.");
    }
    const args = ["dev"];
    if (parsed.devPath) args.push(parsed.devPath);
    if (parsed.devLane) args.push("--lane", parsed.devLane);
    if (parsed.json) args.push("--json");
    return await streamNativeRunxToIo(io, args, env);
  }

  if (parsed.command === "mcp" && parsed.mcpAction === "serve") {
    await handleMcpServeCommand(parsed, io, env, { resolveDefaultReceiptDir });
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

  if (parsed.command === "config" && parsed.configAction) {
    const result = await handleConfigCommand(parsed, env);
    if (parsed.json) {
      io.stdout.write(`${JSON.stringify({ status: "success", config: result }, null, 2)}\n`);
    } else {
      io.stdout.write(renderConfigResult(result, env));
    }
    return 0;
  }

  if (parsed.command === "policy" && parsed.policyAction) {
    if (!parsed.policyPath) {
      throw new Error("policy path is required.");
    }
    const args = ["policy", parsed.policyAction, resolvePathFromUserInput(parsed.policyPath, env)];
    if (parsed.json) args.push("--json");
    return await streamNativeRunxToIo(io, args, env);
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
    return await streamNativeRunxToIo(io, nativeToolArgs("search", parsed.searchQuery, parsed), env);
  }

  if (parsed.command === "tool" && parsed.toolAction === "inspect" && parsed.toolRef) {
    return await streamNativeRunxToIo(io, nativeToolArgs("inspect", parsed.toolRef, parsed), env);
  }

  if (parsed.command === "skill" && parsed.skillAction === "search" && parsed.searchQuery) {
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

  if (parsed.retiredSkillAdd) {
    return writeAddValidationError(
      io,
      parsed,
      "runx skill add is no longer supported. Use `runx add <skill-ref|github-url>` instead.",
      64,
    );
  }

  if (parsed.command === "publish") {
    if (!parsed.receiptPublishPath) {
      io.stderr.write("runx publish: receipt JSON path is required\n");
      return 64;
    }
    const args = ["publish", resolvePathFromUserInput(parsed.receiptPublishPath, env)];
    pushOptionalFlag(args, "--api-base-url", parsed.receiptPublishApiBaseUrl);
    pushOptionalFlag(args, "--token", parsed.receiptPublishToken);
    if (parsed.receiptPublishAllowLocalApi) args.push("--allow-local-api");
    if (parsed.json) args.push("--json");
    return await streamNativeRunxToIo(io, args, env);
  }

  if (parsed.command === "add" && parsed.addRef && isGithubRepoUrl(parsed.addRef)) {
    if (parsed.registryUrl) {
      return writeAddValidationError(io, parsed, "GitHub URL indexing uses --api-base-url for the hosted index API, not --registry.");
    }
    if (parsed.addVersion) {
      return writeAddValidationError(
        io,
        parsed,
        "GitHub URL indexing uses --ref <git-ref>, not --version. Try `runx add <github-url> --ref <git-ref>`.",
      );
    }
    if (parsed.addTo || parsed.expectedDigest) {
      return writeAddValidationError(
        io,
        parsed,
        "GitHub URL indexing does not support --to or --digest. Index the URL, then install the emitted registry ref with `runx add <skill-ref>`.",
      );
    }
    if (parsed.addInstallationId) {
      return writeAddValidationError(io, parsed, "GitHub URL indexing does not accept --installation-id.");
    }
    try {
      const result = await publishUrlSkill({
        repoUrl: parsed.addRef,
        ref: parsed.addGitRef,
        apiBaseUrl: parsed.addApiBaseUrl ?? resolveUrlAddApiBaseUrl(env),
      });
      if (parsed.json) {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        io.stdout.write(renderUrlAddResult(result));
      }
      return 0;
    } catch (error) {
      if (error instanceof UrlAddCliError) {
        const detail = error.payload.hint ? `${error.payload.detail}\n  hint: ${error.payload.hint}` : error.payload.detail;
        io.stderr.write(`runx add: ${detail}\n`);
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === "add" && parsed.addRef) {
    if (parsed.addGitRef) {
      return writeAddValidationError(io, parsed, "--ref is only valid for GitHub repository URLs. Use --version for registry skill refs.");
    }
    const registryTarget = resolveRunxRegistryTarget(env, { registry: parsed.registryUrl });
    const installState = registryTarget.mode === "remote"
      ? await ensureRunxInstallState(resolveRunxGlobalHomeDir(env))
      : undefined;
    const args = [
      "registry",
      "install",
      parsed.addRef,
      "--json",
      "--to",
      resolveSkillInstallRoot(env, parsed.addTo),
    ];
    pushOptionalFlag(args, "--registry", parsed.registryUrl);
    pushOptionalFlag(args, "--version", parsed.addVersion);
    pushOptionalFlag(args, "--digest", parsed.expectedDigest);
    pushOptionalFlag(args, "--installation-id", parsed.addInstallationId ?? installState?.state.installation_id);
    return await streamNativeRunxToIo(io, args, env);
  }

  if (parsed.command === "skill" && parsed.skillAction === "publish" && parsed.publishPath) {
    const resolvedPublishPath = resolvePathFromUserInput(parsed.publishPath, env);
    const args = ["registry", "publish", resolvedPublishPath, "--json"];
    pushOptionalFlag(args, "--registry", parsed.registryUrl);
    pushOptionalFlag(args, "--owner", parsed.publishOwner);
    pushOptionalFlag(args, "--version", parsed.publishVersion);
    pushOptionalFlag(args, "--profile", parsed.publishProfile);
    return await streamNativeRunxToIo(io, args, env);
  }

  if (parsed.command === "history") {
    if (parsed.json) {
      return await streamNativeRunxToIo(io, nativeHistoryArgs(parsed, env), env);
    }
    const history = await handleHistoryCommand(parsed, env);
    io.stdout.write(renderHistory(history.receipts, env, parsed.historyQuery, history.pendingRuns));
    return 0;
  }

  if (parsed.command === "export-receipts" && parsed.exportAction === "trainable") {
    const receiptDir = parsed.receiptDir
      ? resolvePathFromUserInput(parsed.receiptDir, env)
      : resolveDefaultReceiptDir(env);
    for await (const record of streamTrainableReceipts({
      receiptDir,
      runxHome: env.RUNX_HOME,
      // Hydrate `acts[].context_ref` + `artifact_refs` from the conventional
      // sibling artifacts directory when present.
      artifactDir: path.join(receiptDir, "..", "artifacts"),
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
      skillPath: "evolve",
      inputs: evolveInputs,
      parsed,
      env,
    });
    return writeLocalSkillResult(io, env, parsed, result);
  }

  const result = await executeLocalSkillCommand({
    skillPath: parsed.skillPath ?? "",
    inputs: parsed.inputs,
    parsed,
    env,
  });
  return writeLocalSkillResult(io, env, parsed, result);
}

export function writeCliError(io: CliIo, message: string): number {
  io.stderr.write(renderCliError(message));
  return 1;
}

function writeAddValidationError(
  io: CliIo,
  parsed: ParsedArgs,
  message: string,
  exitCode = 1,
): number {
  if (parsed.json) {
    io.stdout.write(`${JSON.stringify({ status: "failure", error: { message, code: "invalid_args" } }, null, 2)}\n`);
    return exitCode;
  }
  io.stderr.write(`runx add: ${message}\n`);
  return exitCode;
}

async function executeLocalSkillCommand(options: {
  readonly skillPath: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly parsed: ParsedArgs;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliSkillRunResult> {
  const env = await withBundledCliToolRoots(options.env);
  const resolvedReceiptDir = options.parsed.receiptDir ? resolvePathFromUserInput(options.parsed.receiptDir, env) : undefined;

  const args = ["skill", options.skillPath, ...inputArgs(options.inputs), "--json"];
  pushOptionalFlag(args, "--registry", options.parsed.registryUrl);
  pushOptionalFlag(args, "--digest", options.parsed.expectedDigest);
  pushOptionalFlag(args, "--runner", options.parsed.runner);
  pushOptionalFlag(args, "--receipt-dir", resolvedReceiptDir);
  pushOptionalFlag(args, "--run-id", options.parsed.runId);
  pushOptionalFlag(
    args,
    "--answers",
    options.parsed.answersPath ? resolvePathFromUserInput(options.parsed.answersPath, env) : undefined,
  );
  if (options.parsed.nonInteractive) {
    args.push("--non-interactive");
  }

  const result = await runNativeRunx(args, { env });
  const output = parseNativeSkillOutput(args, result);
  return nativeSkillRunResult(options.skillPath, output);
}

async function withBundledCliToolRoots(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const bundledRoots = await resolveBundledCliToolRoots();
  if (bundledRoots.length === 0) {
    return env;
  }
  const configuredRoots = String(env.RUNX_TOOL_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const merged = [...configuredRoots];
  for (const root of bundledRoots) {
    if (!merged.includes(root)) {
      merged.push(root);
    }
  }
  return {
    ...env,
    RUNX_TOOL_ROOTS: merged.join(path.delimiter),
  };
}

function resolveKnowledgeDir(env: NodeJS.ProcessEnv): string {
  return resolveRunxKnowledgeDir(env);
}

function resolveDefaultReceiptDir(env: NodeJS.ProcessEnv): string {
  if (env.RUNX_RECEIPT_DIR) {
    return path.resolve(env.RUNX_RECEIPT_DIR);
  }
  return path.join(resolveRunxGlobalHomeDir(env), "receipts");
}

async function streamNativeRunxToIo(
  io: CliIo,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const result = await streamNativeRunx(args, { env, stdout: io.stdout, stderr: io.stderr });
  return result.status ?? 1;
}

function nativeToolArgs(action: "search" | "inspect", value: string, parsed: ParsedArgs): string[] {
  const args = ["tool", action, value];
  pushOptionalFlag(args, "--source", parsed.sourceFilter);
  if (parsed.json) {
    args.push("--json");
  }
  return args;
}

function nativeHistoryArgs(parsed: ParsedArgs, env: NodeJS.ProcessEnv): string[] {
  const args = ["history"];
  if (parsed.historyQuery) args.push(parsed.historyQuery);
  pushOptionalFlag(args, "--receipt-dir", parsed.receiptDir ? resolvePathFromUserInput(parsed.receiptDir, env) : undefined);
  pushOptionalFlag(args, "--skill", parsed.historySkill);
  pushOptionalFlag(args, "--status", parsed.historyStatus);
  pushOptionalFlag(args, "--source", parsed.historySource);
  pushOptionalFlag(args, "--actor", parsed.historyActor);
  pushOptionalFlag(args, "--artifact-type", parsed.historyArtifactType);
  pushOptionalFlag(args, "--since", parsed.historySince);
  pushOptionalFlag(args, "--until", parsed.historyUntil);
  args.push("--json");
  return args;
}

function pushOptionalFlag(args: string[], flag: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) {
    args.push(flag, value);
  }
}

function inputArgs(inputs: Readonly<Record<string, unknown>>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(inputs)) {
    if (value === undefined) {
      continue;
    }
    args.push(`--${key}`, cliInputValue(value));
  }
  return args;
}

function cliInputValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function parseNativeSkillOutput(args: readonly string[], result: NativeRunxProcessResult): unknown {
  if (result.status !== 0 && result.status !== 2) {
    throw new Error(
      `native runx ${args.join(" ")} failed with ${nativeRunxExitDescription(result)}: ${firstNonEmpty(result.stderr, result.stdout, "no output")}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`native runx ${args.join(" ")} returned invalid skill JSON: ${(error as Error).message}`);
  }
}

function nativeRunxExitDescription(result: NativeRunxProcessResult): string {
  if (result.status !== null) {
    return `exit ${result.status}`;
  }
  if (result.signal) {
    return `signal ${result.signal}`;
  }
  return "unknown status";
}

function nativeSkillRunResult(skillPath: string, value: unknown): CliSkillRunResult {
  if (!isRecord(value)) {
    throw new Error("native runx skill returned a non-object payload.");
  }
  const status = stringField(value, "status");
  const skillName = stringField(value, "skill_name") ?? path.basename(skillPath);
  if (status === "needs_agent") {
    const runId = stringField(value, "run_id");
    const requests = arrayValue(value.requests) as Extract<CliSkillRunResult, { readonly status: "needs_agent" }>["requests"];
    if (!runId) {
      throw new Error("native runx skill needs_agent payload is missing run_id.");
    }
    return {
      status: "needs_agent",
      skill: { name: skillName },
      skillPath,
      runId,
      requests,
    };
  }
  if (status === "sealed") {
    const execution = recordField(value, "execution");
    const receipt = recordField(value, "receipt") as CliRuntimeReceipt | undefined;
    if (!execution || !receipt || typeof receipt.id !== "string" || typeof receipt.schema !== "string") {
      throw new Error("native runx skill sealed payload is missing execution or receipt.");
    }
    return {
      ...value,
      status: receipt.seal?.disposition === "closed" ? "sealed" : "failure",
      skill: { name: skillName },
      execution: {
        stdout: stringField(execution, "stdout") ?? "",
        stderr: stringField(execution, "stderr") ?? "",
        errorMessage: stringField(execution, "errorMessage") ?? stringField(execution, "error_message"),
        ...execution,
      },
      receipt,
    } as CliSkillRunResult;
  }
  throw new Error(`native runx skill returned unsupported status '${status ?? "<missing>"}'.`);
}
