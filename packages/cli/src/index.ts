#!/usr/bin/env node

export const cliPackage = "@runxhq/cli";

import { realpathSync } from "node:fs";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { pathToFileURL } from "node:url";

import { resolvePathFromUserInput } from "@runxhq/core/config";
import { errorMessage } from "@runxhq/core/util";

import { createAgentRuntimeLoader, createInteractiveCaller, createNonInteractiveCaller, readCallerInputFile } from "./callers.js";
import { configAction } from "./commands/config.js";
import {
  normalizeConnectAuthorityKind,
  parseConnectAction,
  type ConnectAuthorityKind,
  type ConnectService,
} from "./commands/connect.js";
import { normalizeListKind, type RunxListRequestedKind } from "./commands/list.js";
import { dispatchCli, writeCliError } from "./dispatch.js";
import { isHelpRequest, writeUsage } from "./help.js";

export { resolveSkillReference, resolveRunnableSkillReference, createOfficialSkillResolver } from "./skill-refs.js";

export interface CliIo {
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
}

export interface CliServices {
  readonly connect?: ConnectService;
}

export interface ParsedArgs {
  readonly command?: string;
  readonly subcommand?: string;
  readonly mcpAction?: "serve";
  readonly mcpRefs?: readonly string[];
  readonly doctorPath?: string;
  readonly doctorFix: boolean;
  readonly doctorExplainId?: string;
  readonly doctorListDiagnostics: boolean;
  readonly toolAction?: "build" | "search" | "inspect";
  readonly toolPath?: string;
  readonly toolRef?: string;
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
  readonly replayRef?: string;
  readonly diffLeft?: string;
  readonly diffRight?: string;
  readonly historyQuery?: string;
  readonly historySkill?: string;
  readonly historyStatus?: string;
  readonly historySource?: string;
  readonly historyActor?: string;
  readonly historyArtifactType?: string;
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
  "mcp",
  "list",
  "tool",
  "skill",
  "evolve",
  "resume",
  "replay",
  "diff",
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
    const callerInput = parsed.answersPath
      ? await readCallerInputFile(resolvePathFromUserInput(parsed.answersPath, env))
      : { answers: {} };
    const agentRuntimeLoader = createAgentRuntimeLoader(env);
    const nonInteractive = parsed.nonInteractive || parsed.json;
    const caller = nonInteractive
      ? createNonInteractiveCaller(callerInput.answers, callerInput.approvals, agentRuntimeLoader)
      : createInteractiveCaller(io, callerInput.answers, callerInput.approvals, { reportEvents: !parsed.json }, env, agentRuntimeLoader);
    return await dispatchCli(parsed, io, env, caller, services);
  } catch (error) {
    const message = errorMessage(error);
    return writeCliError(io, message);
  }
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
  const isReplay = command === "replay";
  const isDiff = command === "diff";
  const isDoctor = command === "doctor";
  const isTool = command === "tool";
  const isToolSearch = isTool && positionals[0] === "search";
  const isToolInspect = isTool && positionals[0] === "inspect";
  const isDev = command === "dev";
  const isMcp = command === "mcp";
  const isList = command === "list";
  const isExportReceipts = command === "export-receipts";
  const isTopLevelSkillInvoke = Boolean(command) && !builtinRootCommands.has(command);
  const searchPositionals = positionals.slice(adminOffset);
  const toolSearchPositionals = isTool ? positionals.slice(1) : [];
  const addPositionals = positionals.slice(adminOffset);
  const inspectPositionals = positionals.slice(adminOffset);
  const knowledgeProject = isKnowledgeShow && typeof inputs.project === "string" ? inputs.project : undefined;
  const sourceFilter = (isSkillSearch || isToolSearch || isToolInspect) && typeof inputs.source === "string" ? inputs.source : undefined;
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
                        ? omitInputs(inputs, ["all", "source"])
                        : isDev
                          ? omitInputs(inputs, ["lane", "record", "realAgents", "real-agents", "watch"])
                          : isMcp
                            ? inputs
                            : isList
                              ? omitInputs(inputs, ["okOnly", "ok-only", "invalidOnly", "invalid-only"])
                              : isExportReceipts
                                ? omitInputs(inputs, ["trainable", "since", "until", "status", "source"])
                                : inputs;

  return {
    command,
    subcommand: positionals[0],
    mcpAction: isMcp && positionals[0] === "serve" ? "serve" : undefined,
    mcpRefs: isMcp && positionals[0] === "serve" ? positionals.slice(1) : undefined,
    doctorPath: isDoctor ? positionals[0] : undefined,
    doctorFix: isDoctor && truthyFlag(inputs.fix),
    doctorExplainId: isDoctor && typeof inputs.explain === "string" && inputs.explain !== "true" ? inputs.explain : undefined,
    doctorListDiagnostics: isDoctor && truthyFlag(inputs.listDiagnostics ?? inputs["list-diagnostics"]),
    toolAction: isTool && (positionals[0] === "build" || positionals[0] === "search" || positionals[0] === "inspect") ? positionals[0] : undefined,
    toolPath: isTool && positionals[0] === "build" ? positionals[1] : undefined,
    toolRef: isToolInspect ? toolSearchPositionals.join(" ") || undefined : undefined,
    toolAll: isTool && truthyFlag(inputs.all),
    devPath: isDev ? positionals[0] : undefined,
    devLane: isDev && typeof inputs.lane === "string" ? inputs.lane : undefined,
    devRecord: isDev && truthyFlag(inputs.record),
    devRealAgents: isDev && (truthyFlag(inputs.realAgents ?? inputs["real-agents"]) || truthyFlag(inputs.record)),
    devWatch: isDev && truthyFlag(inputs.watch),
    listKind: isList ? normalizeListKind(positionals[0]) : undefined,
    listOkOnly: isList && truthyFlag(inputs.okOnly ?? inputs["ok-only"]),
    listInvalidOnly: isList && truthyFlag(inputs.invalidOnly ?? inputs["invalid-only"]),
    exportAction: isExportReceipts && truthyFlag(inputs.trainable) ? "trainable" : undefined,
    skillAction: isSkillSearch ? "search" : isSkillAdd ? "add" : isSkillPublish ? "publish" : isSkillInspect ? "inspect" : undefined,
    knowledgeAction: isKnowledgeShow ? "show" : undefined,
    searchQuery: isSkillSearch
      ? searchPositionals.join(" ") || undefined
      : isToolSearch
        ? toolSearchPositionals.join(" ") || undefined
        : undefined,
    skillRef: isSkillAdd ? addPositionals.join(" ") || undefined : undefined,
    publishPath: isSkillPublish ? positionals[1] : undefined,
    receiptId: isSkillInspect ? inspectPositionals[0] : undefined,
    replayRef: isReplay ? positionals[0] : undefined,
    diffLeft: isDiff ? positionals[0] : undefined,
    diffRight: isDiff ? positionals[1] : undefined,
    historyQuery: command === "history" ? positionals.join(" ") || undefined : undefined,
    historySkill: command === "history" && typeof inputs.skill === "string" ? inputs.skill : undefined,
    historyStatus: command === "history" && typeof inputs.status === "string" ? inputs.status : undefined,
    historySource: command === "history" && typeof inputs.source === "string" ? inputs.source : undefined,
    historyActor: command === "history" && typeof inputs.actor === "string" ? inputs.actor : undefined,
    historyArtifactType:
      command === "history" && typeof (inputs.artifactType ?? inputs.artifact_type ?? inputs["artifact-type"]) === "string"
        ? String(inputs.artifactType ?? inputs.artifact_type ?? inputs["artifact-type"])
        : undefined,
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
  if (parsed.command === "tool" && parsed.toolAction === "search" && parsed.searchQuery) {
    return true;
  }
  if (parsed.command === "tool" && parsed.toolAction === "inspect" && parsed.toolRef) {
    return true;
  }
  if (parsed.command === "tool" && parsed.toolAction && (parsed.toolAll || parsed.toolPath)) {
    return true;
  }
  if (parsed.command === "dev") {
    return true;
  }
  if (parsed.command === "mcp" && parsed.mcpAction === "serve" && (parsed.mcpRefs?.length ?? 0) > 0) {
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
  if (parsed.command === "replay" && parsed.replayRef) {
    return true;
  }
  if (parsed.command === "diff" && parsed.diffLeft && parsed.diffRight) {
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

function normalizeKnownFlag(rawKey: string): string {
  return rawKey.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
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

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const exitCode = await runCli(process.argv.slice(2), {
    stdin: processStdin,
    stdout: processStdout,
    stderr: process.stderr,
  });
  process.exitCode = exitCode;
}
