import { configAction } from "./commands/config.js";
import { normalizeListKind, type RunxListRequestedKind } from "./commands/list.js";
import { policyAction, type PolicyAction } from "./commands/policy.js";

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
  readonly skillAction?: "search" | "publish" | "inspect";
  readonly retiredSkillAdd: boolean;
  readonly knowledgeAction?: "show";
  readonly searchQuery?: string;
  readonly addRef?: string;
  readonly publishPath?: string;
  readonly receiptPublishPath?: string;
  readonly receiptPublishApiBaseUrl?: string;
  readonly receiptPublishToken?: string;
  readonly receiptPublishAllowLocalApi: boolean;
  readonly receiptId?: string;
  readonly runId?: string;
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
  readonly addVersion?: string;
  readonly addGitRef?: string;
  readonly addApiBaseUrl?: string;
  readonly addTo?: string;
  readonly addInstallationId?: string;
  readonly publishOwner?: string;
  readonly publishVersion?: string;
  readonly publishProfile?: string;
  readonly registryUrl?: string;
  readonly expectedDigest?: string;
  readonly configAction?: "set" | "get" | "list";
  readonly configKey?: string;
  readonly configValue?: string;
  readonly policyAction?: PolicyAction;
  readonly policyPath?: string;
  readonly newName?: string;
  readonly newDirectory?: string;
  readonly initAction?: "project" | "global";
  readonly prefetchOfficial: boolean;
  readonly exportSince?: string;
  readonly exportUntil?: string;
  readonly exportStatus?: string;
  readonly exportSource?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const inputs: Record<string, unknown> = {};
  let nonInteractive = false;
  let json = false;
  let answersPath: string | undefined;
  let receiptDir: string | undefined;
  let runId: string | undefined;
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
    const value = parseInputValue(inlineValue ?? next);
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

    if (knownKey === "runId") {
      runId = String(value);
      continue;
    }

    if (knownKey === "runner") {
      runner = String(value);
      continue;
    }

    inputs[rawKey] = mergeInputValue(inputs[rawKey], value);
  }

  const adminOffset = command === "skill" ? 1 : 0;
  const isSkillSearch = command === "skill" && positionals[0] === "search";
  const isTopLevelAdd = command === "add";
  const isRetiredSkillAdd = command === "skill" && positionals[0] === "add";
  const isSkillPublish = command === "skill" && positionals[0] === "publish";
  const isReceiptPublish = command === "publish";
  const isSkillInspect = command === "skill" && positionals[0] === "inspect";
  const isSkillRun =
    command === "skill" && !isSkillSearch && !isRetiredSkillAdd && !isSkillPublish && !isSkillInspect;
  const isKnowledgeShow = command === "knowledge" && positionals[0] === "show";
  const isConfig = command === "config";
  const isPolicy = command === "policy";
  const isNew = command === "new";
  const isInit = command === "init";
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
  const searchPositionals = positionals.slice(adminOffset);
  const toolSearchPositionals = isTool ? positionals.slice(1) : [];
  const inspectPositionals = positionals.slice(adminOffset);
  const knowledgeProject = isKnowledgeShow && typeof inputs.project === "string" ? inputs.project : undefined;
  const sourceFilter = (isSkillSearch || isToolSearch || isToolInspect) && typeof inputs.source === "string" ? inputs.source : undefined;
  const addVersion = isTopLevelAdd && typeof inputs.version === "string" ? inputs.version : undefined;
  const addGitRef = isTopLevelAdd && typeof inputs.ref === "string" ? inputs.ref : undefined;
  const addApiBaseUrl = isTopLevelAdd && typeof (inputs.apiBaseUrl ?? inputs["api-base-url"]) === "string"
    ? String(inputs.apiBaseUrl ?? inputs["api-base-url"])
    : undefined;
  const addTo = isTopLevelAdd && typeof inputs.to === "string" ? inputs.to : undefined;
  const addInstallationId = isTopLevelAdd && typeof (inputs.installationId ?? inputs["installation-id"]) === "string"
    ? String(inputs.installationId ?? inputs["installation-id"])
    : undefined;
  const publishOwner = isSkillPublish && typeof inputs.owner === "string" ? inputs.owner : undefined;
  const publishVersion = isSkillPublish && typeof inputs.version === "string" ? inputs.version : undefined;
  const publishProfile = isSkillPublish && typeof inputs.profile === "string" ? inputs.profile : undefined;
  const receiptPublishPath = isReceiptPublish ? positionals[0] : undefined;
  const receiptPublishApiBaseUrl =
    isReceiptPublish && typeof (inputs.apiBaseUrl ?? inputs["api-base-url"]) === "string"
      ? String(inputs.apiBaseUrl ?? inputs["api-base-url"])
      : undefined;
  const receiptPublishToken = isReceiptPublish && typeof inputs.token === "string" ? inputs.token : undefined;
  const receiptPublishAllowLocalApi =
    isReceiptPublish && truthyFlag(inputs.allowLocalApi ?? inputs["allow-local-api"]);
  const registryUrl = (isSkillSearch || isTopLevelAdd || isSkillPublish || isSkillRun) && typeof inputs.registry === "string" ? inputs.registry : undefined;
  const expectedDigest = (isTopLevelAdd || isSkillRun) && typeof inputs.digest === "string" ? normalizeDigest(inputs.digest) : undefined;
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
    : isTopLevelAdd
      ? omitInputs(inputs, ["version", "ref", "apiBaseUrl", "api-base-url", "to", "registry", "digest", "installationId", "installation-id"])
      : isReceiptPublish
        ? omitInputs(inputs, ["apiBaseUrl", "api-base-url", "token", "allowLocalApi", "allow-local-api"])
      : isRetiredSkillAdd
        ? {}
        : isSkillPublish
          ? omitInputs(inputs, ["version", "owner", "registry", "profile"])
          : isSkillRun
            ? omitInputs(inputs, ["registry", "digest"])
            : isConfig
              ? {}
              : isPolicy
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
    skillAction: isSkillSearch ? "search" : isSkillPublish ? "publish" : isSkillInspect ? "inspect" : undefined,
    retiredSkillAdd: isRetiredSkillAdd,
    knowledgeAction: isKnowledgeShow ? "show" : undefined,
    searchQuery: isSkillSearch
      ? searchPositionals.join(" ") || undefined
      : isToolSearch
        ? toolSearchPositionals.join(" ") || undefined
        : undefined,
    addRef: isTopLevelAdd ? positionals.join(" ") || undefined : undefined,
    publishPath: isSkillPublish ? positionals[1] : undefined,
    receiptPublishPath,
    receiptPublishApiBaseUrl,
    receiptPublishToken,
    receiptPublishAllowLocalApi,
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
      command === "skill" && !isSkillSearch && !isRetiredSkillAdd && !isSkillPublish && !isSkillInspect
        ? positionals[0]
        : undefined,
    harnessPath: command === "harness" ? positionals[0] : undefined,
    evolveObjective: command === "evolve" ? positionals.join(" ") || undefined : undefined,
    inputs: effectiveInputs,
    nonInteractive,
    json,
    answersPath,
    receiptDir,
    runId,
    runner,
    knowledgeProject,
    sourceFilter,
    addVersion,
    addGitRef,
    addApiBaseUrl,
    addTo,
    addInstallationId,
    publishOwner,
    publishVersion,
    publishProfile,
    registryUrl,
    expectedDigest,
    configAction: isConfig ? configAction(positionals) : undefined,
    configKey: isConfig ? positionals[1] : undefined,
    configValue: isConfig ? positionals.slice(2).join(" ") || undefined : undefined,
    policyAction: isPolicy ? policyAction(positionals) : undefined,
    policyPath: isPolicy ? positionals[1] : undefined,
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

export function isSupportedCommand(parsed: ParsedArgs): boolean {
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
  if (parsed.command === "skill" && parsed.skillAction === "search" && parsed.searchQuery) {
    return true;
  }
  if (parsed.command === "add" && parsed.addRef) {
    return true;
  }
  if (parsed.retiredSkillAdd) {
    return true;
  }
  if (parsed.command === "skill" && parsed.skillAction === "publish" && parsed.publishPath) {
    return true;
  }
  if (parsed.command === "publish" && parsed.receiptPublishPath) {
    return true;
  }
  if (parsed.skillPath) {
    return true;
  }
  if (parsed.command === "evolve") {
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
  if (parsed.command === "config" && parsed.configAction === "list") {
    return true;
  }
  if (parsed.command === "config" && parsed.configAction === "get" && parsed.configKey) {
    return true;
  }
  if (parsed.command === "config" && parsed.configAction === "set" && parsed.configKey && parsed.configValue !== undefined) {
    return true;
  }
  if (parsed.command === "policy" && parsed.policyAction && parsed.policyPath) {
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

function parseInputValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
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
