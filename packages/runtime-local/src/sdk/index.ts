export const sdkJsPackage = "@runxhq/runtime-local/sdk";

export * from "./caller.js";
export * from "./capability-execution.js";
export * from "./host-protocol.js";
export * from "./trusted-host-outcome.js";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  loadLocalSkillPackage,
  resolvePathFromUserInput,
  resolveRunxGlobalHomeDir,
  resolveRunxProjectDir,
  resolveRunxRegistryTarget,
  resolveSkillInstallRoot,
} from "@runxhq/core/config";
import { isNotFound, isRecord } from "@runxhq/core/util";
import {
  createFixtureMarketplaceAdapter,
  searchMarketplaceAdapters,
  type MarketplaceAdapter,
  type SkillSearchResult,
} from "@runxhq/core/marketplaces";
import {
  resolveEnvToolCatalogAdapters,
  resolveCatalogTool,
  searchToolCatalogAdapters,
  createToolInspectResult,
  inspectCatalogResolvedTool,
  type ToolCatalogAdapter,
  type ToolInspectResult,
  type ToolCatalogSearchResult,
} from "@runxhq/runtime-local/tool-catalogs";
import { type LocalReceipt, type ReceiptVerification } from "@runxhq/core/receipts";
import {
  createFileRegistryStore,
  createLocalRegistryClient,
  publishSkillMarkdown,
  readRemoteTool,
  searchRemoteRegistry,
  searchRemoteTools,
  searchRegistry,
  type PublishSkillMarkdownOptions,
  type PublishSkillMarkdownResult,
  type RegistryStore,
} from "@runxhq/core/registry";
import {
  installLocalSkill,
  inspectLocalReceipt,
  listLocalHistory,
  resolveToolExecutionTarget,
  runLocalSkill,
  type AuthResolver,
  type Caller,
  type InstallLocalSkillResult,
  type RunLocalSkillResult,
} from "../runner-local/index.js";
import { validatePublishHarness, type PublishHarnessSummary } from "../harness/index.js";
import type { SkillAdapter } from "@runxhq/core/executor";
import { parseToolManifestJson, validateToolManifest } from "@runxhq/core/parser";
import { createStructuredCaller, type StructuredCallerOptions } from "./caller.js";
import {
  createHostBridge,
  inspectLocalHostState,
  type HostBridge,
  type HostInspectOptions,
  type HostRunOptions,
  type HostRunResult,
  type HostRunState,
} from "./host-protocol.js";

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

export interface RunxSdkOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly caller?: Caller;
  readonly callerOptions?: StructuredCallerOptions;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly registryDir?: string;
  readonly registryUrl?: string;
  readonly registryStore?: RegistryStore;
  readonly marketplaceAdapters?: readonly MarketplaceAdapter[];
  readonly toolCatalogAdapters?: readonly ToolCatalogAdapter[];
  readonly connect?: ConnectService;
  readonly authResolver?: AuthResolver;
  readonly allowedSourceTypes?: readonly string[];
  readonly adapters?: readonly SkillAdapter[];
  readonly voiceProfilePath?: string;
}

export interface RunSkillOptions {
  readonly skillPath: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly answersPath?: string;
  readonly runner?: string;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly parentReceipt?: string;
  readonly contextFrom?: readonly string[];
  readonly caller?: Caller;
  readonly authResolver?: AuthResolver;
  readonly allowedSourceTypes?: readonly string[];
  readonly resumeFromRunId?: string;
  readonly adapters?: readonly SkillAdapter[];
  readonly voiceProfilePath?: string;
}

export interface SearchSkillsOptions {
  readonly query: string;
  readonly source?: string;
  readonly limit?: number;
}

export interface SearchToolsOptions {
  readonly query: string;
  readonly source?: string;
  readonly limit?: number;
}

export interface InspectToolOptions {
  readonly ref: string;
  readonly source?: string;
  readonly searchFromDirectory?: string;
}

export interface AddSkillOptions {
  readonly ref: string;
  readonly version?: string;
  readonly to?: string;
  readonly expectedDigest?: string;
  readonly registryUrl?: string;
}

export interface PublishSkillOptions extends PublishSkillMarkdownOptions {
  readonly skillPath: string;
}

export interface PublishSkillResult extends PublishSkillMarkdownResult {
  readonly harness: PublishHarnessSummary;
}

export interface InspectReceiptOptions {
  readonly receiptId: string;
  readonly receiptDir?: string;
}

export interface HistoryOptions {
  readonly receiptDir?: string;
  readonly limit?: number;
}

export interface HistoryEntry {
  readonly id: string;
  readonly kind: LocalReceipt["kind"];
  readonly status: LocalReceipt["status"];
  readonly verification: ReceiptVerification;
  readonly path: string;
  readonly started_at?: string;
  readonly completed_at?: string;
}

export type InspectReceiptResult = LocalReceipt & {
  readonly verification: ReceiptVerification;
};

export class RunxSdk {
  constructor(private readonly options: RunxSdkOptions = {}) {}

  async runSkill(options: RunSkillOptions): Promise<RunLocalSkillResult> {
    return await runLocalSkill({
      skillPath: resolvePathFromUserInput(options.skillPath, this.env()),
      inputs: options.inputs,
      answersPath: options.answersPath ? resolvePathFromUserInput(options.answersPath, this.env()) : undefined,
      caller: this.caller(options.caller),
      env: this.env(),
      receiptDir: this.receiptDir(options.receiptDir),
      runner: options.runner,
      runxHome: options.runxHome ?? this.options.runxHome,
      parentReceipt: options.parentReceipt,
      contextFrom: options.contextFrom,
      allowedSourceTypes: options.allowedSourceTypes ?? this.options.allowedSourceTypes,
      authResolver: options.authResolver ?? this.options.authResolver,
      resumeFromRunId: options.resumeFromRunId,
      adapters: options.adapters ?? this.options.adapters,
      voiceProfilePath: options.voiceProfilePath ?? this.options.voiceProfilePath,
      toolCatalogAdapters: this.toolCatalogAdapters(),
    });
  }

  async inspectReceipt(options: InspectReceiptOptions): Promise<InspectReceiptResult> {
    const inspection = await inspectLocalReceipt({
      receiptId: options.receiptId,
      receiptDir: this.receiptDir(options.receiptDir),
      runxHome: this.options.runxHome ?? this.env().RUNX_HOME,
      env: this.env(),
    });
    return {
      ...inspection.receipt,
      verification: inspection.verification,
    };
  }

  async history(options: HistoryOptions = {}): Promise<readonly HistoryEntry[]> {
    const receiptDir = this.receiptDir(options.receiptDir);
    const history = await listLocalHistory({
      receiptDir,
      runxHome: this.options.runxHome ?? this.env().RUNX_HOME,
      env: this.env(),
      limit: options.limit,
    });
    return history.receipts.map((receipt) => ({
      id: receipt.id,
      kind: receipt.kind,
      status: receipt.status,
      verification: receipt.verification,
      path: path.join(receiptDir, `${receipt.id}.json`),
      started_at: receipt.startedAt,
      completed_at: receipt.completedAt,
    }));
  }

  async hostRun(options: HostRunOptions & {
    readonly resolver?: Parameters<HostBridge["run"]>[0]["resolver"];
  }): Promise<HostRunResult> {
    return await buildRunxHostBridge(this).run(options);
  }

  async hostResume(
    runId: string,
    options: Omit<HostRunOptions, "resumeFromRunId" | "skillPath"> & {
      readonly skillPath?: string;
      readonly resolver?: Parameters<HostBridge["resume"]>[1]["resolver"];
    } = {},
  ): Promise<HostRunResult> {
    return await buildRunxHostBridge(this).resume(runId, options);
  }

  async inspectHost(referenceId: string, options: HostInspectOptions = {}): Promise<HostRunState> {
    return await inspectLocalHostState(referenceId, {
      receiptDir: this.receiptDir(options.receiptDir),
      runxHome: options.runxHome ?? this.options.runxHome,
      env: this.env(),
    });
  }

  async searchSkills(options: SearchSkillsOptions): Promise<readonly SkillSearchResult[]> {
    const normalizedSource = options.source?.trim().toLowerCase();
    const results: SkillSearchResult[] = [];

    if (!normalizedSource || normalizedSource === "registry" || normalizedSource === "runx-registry") {
      const registryTarget = this.registryTarget();
      if (registryTarget.mode === "remote") {
        results.push(...(await searchRemoteRegistry(options.query, {
          baseUrl: registryTarget.registryUrl,
          limit: options.limit,
        })));
      } else {
        results.push(
          ...(await searchRegistry(this.registryStore(), options.query, {
            limit: options.limit,
            registryUrl: registryTarget.registryUrl,
          })),
        );
      }
    }

    const marketplaceAdapters = this.marketplaceAdapters(normalizedSource);
    results.push(...(await searchMarketplaceAdapters(marketplaceAdapters, options.query, { limit: options.limit })));

    return results.slice(0, options.limit ?? 20);
  }

  async searchTools(options: SearchToolsOptions): Promise<readonly ToolCatalogSearchResult[]> {
    const normalizedSource = options.source?.trim().toLowerCase();
    const results: ToolCatalogSearchResult[] = [];
    const registryTarget = this.registryTarget();

    if (registryTarget.mode === "remote") {
      results.push(...(await searchRemoteTools(options.query, {
        baseUrl: registryTarget.registryUrl,
        limit: options.limit,
        source: normalizedSource,
      })));
    }

    results.push(...(await searchToolCatalogAdapters(
      this.toolCatalogAdapters(options.source),
      options.query,
      { limit: options.limit },
    )));

    return dedupeToolSearchResults(results).slice(0, options.limit ?? 20);
  }

  async inspectTool(options: InspectToolOptions): Promise<ToolInspectResult> {
    const searchFromDirectory = resolvePathFromUserInput(
      options.searchFromDirectory ?? this.env().RUNX_CWD ?? process.cwd(),
      this.env(),
    );
    const adapters = this.toolCatalogAdapters(options.source);
    let localError: Error | undefined;
    try {
      const resolvedExecutionTarget = await resolveToolExecutionTarget(options.ref, searchFromDirectory, {
        env: this.env(),
        toolCatalogAdapters: adapters,
      });

      if (resolvedExecutionTarget.referencePath.startsWith("catalog:")) {
        const resolvedCatalogTool = await resolveCatalogTool(adapters, options.ref, {
          env: this.env(),
          searchFromDirectory,
        });
        if (!resolvedCatalogTool) {
          throw new Error(`Imported tool '${options.ref}' was resolved for execution but could not be inspected.`);
        }
        return inspectCatalogResolvedTool(options.ref, resolvedCatalogTool);
      }

      const tool = validateToolManifest(parseToolManifestJson(
        await readFile(resolvedExecutionTarget.referencePath, "utf8"),
      ));
      return createToolInspectResult({
        ref: options.ref,
        tool,
        referencePath: resolvedExecutionTarget.referencePath,
        skillDirectory: resolvedExecutionTarget.skillDirectory,
        provenance: {
          origin: "local",
        },
      });
    } catch (error) {
      localError = error instanceof Error ? error : new Error(String(error));
    }

    const registryTarget = this.registryTarget();
    if (registryTarget.mode === "remote") {
      const remoteTool = await readRemoteTool(options.ref, {
        baseUrl: registryTarget.registryUrl,
        source: options.source,
      });
      if (remoteTool) {
        return remoteTool;
      }
    }

    throw localError ?? new Error(`Tool '${options.ref}' was not found.`);
  }

  async addSkill(options: AddSkillOptions): Promise<InstallLocalSkillResult> {
    const registryTarget = this.registryTarget(options.registryUrl);
    const installState = registryTarget.mode === "remote"
      ? await ensureRunxInstallState(resolveRunxGlobalHomeDir(this.env()))
      : undefined;
    return await installLocalSkill({
      ref: options.ref,
      registryStore: registryTarget.mode === "local" ? this.registryStore(options.registryUrl) : undefined,
      marketplaceAdapters: this.marketplaceAdapters(),
      destinationRoot: resolveSkillInstallRoot(this.env(), options.to),
      version: options.version,
      expectedDigest: options.expectedDigest,
      registryUrl: registryTarget.mode === "remote" ? registryTarget.registryUrl : options.registryUrl ?? this.options.registryUrl,
      installationId: installState?.state.installation_id,
    });
  }

  async publishSkill(options: PublishSkillOptions): Promise<PublishSkillResult> {
    const resolvedSkillPath = resolvePathFromUserInput(options.skillPath, this.env());
    const harness = await validatePublishHarness(resolvedSkillPath, {
      env: this.env(),
      adapters: this.options.adapters,
    });
    if (harness.status === "failed") {
      throw new Error(`Harness failed for ${resolvedSkillPath}: ${harness.assertion_errors.join("; ")}`);
    }
    const skillPackage = await loadLocalSkillPackage(resolvedSkillPath);
    const publish = await publishSkillMarkdown(createLocalRegistryClient(this.registryStore(options.registryUrl)), skillPackage.markdown, {
      owner: options.owner,
      version: options.version,
      createdAt: options.createdAt,
      registryUrl: options.registryUrl ?? this.options.registryUrl,
      profileDocument: skillPackage.profileDocument,
    });
    return {
      ...publish,
      harness,
    };
  }

  async connectList(): Promise<unknown> {
    return await this.requireConnect().list();
  }

  async connectPreprovision(request: {
    readonly provider: string;
    readonly scopes?: readonly string[];
    readonly scope_family?: string;
    readonly authority_kind?: "read_only" | "constructive" | "destructive";
    readonly target_repo?: string;
    readonly target_locator?: string;
  }): Promise<unknown> {
    return await this.requireConnect().preprovision({
      ...request,
      scopes: request.scopes ?? [],
    });
  }

  async connectRevoke(grantId: string): Promise<unknown> {
    return await this.requireConnect().revoke(grantId);
  }

  private caller(override?: Caller): Caller {
    return override ?? this.options.caller ?? createStructuredCaller(this.options.callerOptions);
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private receiptDir(override?: string): string {
    return resolvePathFromUserInput(
      override ?? this.options.receiptDir ?? this.env().RUNX_RECEIPT_DIR ?? path.join(resolveRunxProjectDir(this.env()), "receipts"),
      this.env(),
    );
  }

  private registryStore(registryUrl = this.options.registryUrl): RegistryStore {
    if (this.options.registryStore) {
      return this.options.registryStore;
    }
    const target = this.registryTarget(registryUrl);
    return createFileRegistryStore(
      target.mode === "local" ? target.registryPath : path.join(resolveRunxGlobalHomeDir(this.env()), "registry"),
    );
  }

  private registryTarget(registryUrl = this.options.registryUrl) {
    return resolveRunxRegistryTarget(this.env(), { registry: registryUrl, registryDir: this.options.registryDir });
  }

  private marketplaceAdapters(source?: string): readonly MarketplaceAdapter[] {
    if (this.options.marketplaceAdapters) {
      return this.options.marketplaceAdapters;
    }
    if (
      this.env().RUNX_ENABLE_FIXTURE_MARKETPLACE === "1" &&
      (!source || source === "marketplace" || source === "fixture-marketplace")
    ) {
      return [createFixtureMarketplaceAdapter()];
    }
    return [];
  }

  private toolCatalogAdapters(source?: string): readonly ToolCatalogAdapter[] {
    if (this.options.toolCatalogAdapters) {
      return this.options.toolCatalogAdapters;
    }
    return resolveEnvToolCatalogAdapters(this.env(), source);
  }

  private requireConnect(): ConnectService {
    if (!this.options.connect) {
      throw new Error("runx SDK connect methods require a configured connect service.");
    }
    return this.options.connect;
  }
}

export function createRunxSdk(options: RunxSdkOptions = {}): RunxSdk {
  return new RunxSdk(options);
}

export function createRunxHostBridge(options: RunxSdkOptions = {}): HostBridge {
  return buildRunxHostBridge(createRunxSdk(options));
}

export async function runSkill(options: RunSkillOptions & RunxSdkOptions): Promise<RunLocalSkillResult> {
  return await createRunxSdk(options).runSkill(options);
}

export async function hostRun(
  options: HostRunOptions & RunxSdkOptions & {
    readonly resolver?: Parameters<HostBridge["run"]>[0]["resolver"];
  },
): Promise<HostRunResult> {
  return await createRunxSdk(options).hostRun(options);
}

export async function hostResume(
  runId: string,
  options: Omit<HostRunOptions, "resumeFromRunId" | "skillPath"> & RunxSdkOptions & {
    readonly skillPath?: string;
    readonly resolver?: Parameters<HostBridge["resume"]>[1]["resolver"];
  } = {},
): Promise<HostRunResult> {
  return await createRunxSdk(options).hostResume(runId, options);
}

export async function inspectHost(
  referenceId: string,
  options: HostInspectOptions & RunxSdkOptions = {},
): Promise<HostRunState> {
  return await createRunxSdk(options).inspectHost(referenceId, options);
}

function buildRunxHostBridge(sdk: RunxSdk): HostBridge {
  return createHostBridge({
    execute: sdk.runSkill.bind(sdk),
    inspect: sdk.inspectHost.bind(sdk),
  });
}

export async function inspect(options: InspectReceiptOptions & RunxSdkOptions): Promise<InspectReceiptResult> {
  return await createRunxSdk(options).inspectReceipt(options);
}

export async function history(options: HistoryOptions & RunxSdkOptions = {}): Promise<readonly HistoryEntry[]> {
  return await createRunxSdk(options).history(options);
}

export async function search(options: SearchSkillsOptions & RunxSdkOptions): Promise<readonly SkillSearchResult[]> {
  return await createRunxSdk(options).searchSkills(options);
}

export async function searchTools(options: SearchToolsOptions & RunxSdkOptions): Promise<readonly ToolCatalogSearchResult[]> {
  return await createRunxSdk(options).searchTools(options);
}

export async function inspectTool(options: InspectToolOptions & RunxSdkOptions): Promise<ToolInspectResult> {
  return await createRunxSdk(options).inspectTool(options);
}

function dedupeToolSearchResults(results: readonly ToolCatalogSearchResult[]): readonly ToolCatalogSearchResult[] {
  const deduped = new Map<string, ToolCatalogSearchResult>();
  for (const result of results) {
    deduped.set(result.catalog_ref, result);
  }
  return Array.from(deduped.values());
}

interface RunxInstallState {
  readonly version: 1;
  readonly installation_id: string;
  readonly created_at: string;
}

async function ensureRunxInstallState(
  globalHomeDir: string,
  now: () => string = () => new Date().toISOString(),
): Promise<{ readonly state: RunxInstallState; readonly created: boolean }> {
  const existing = await readRunxInstallState(globalHomeDir);
  if (existing) {
    return {
      state: existing,
      created: false,
    };
  }
  const state: RunxInstallState = {
    version: 1,
    installation_id: `inst_${randomUUID()}`,
    created_at: now(),
  };
  await mkdir(globalHomeDir, { recursive: true });
  await writeFile(path.join(globalHomeDir, "install.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return {
    state,
    created: true,
  };
}

async function readRunxInstallState(globalHomeDir: string): Promise<RunxInstallState | undefined> {
  const installPath = path.join(globalHomeDir, "install.json");
  let contents: string;
  try {
    contents = await readFile(installPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(contents);
  if (
    !isRecord(parsed)
    || parsed.version !== 1
    || typeof parsed.installation_id !== "string"
    || typeof parsed.created_at !== "string"
  ) {
    throw new Error(`${installPath} is not a valid Runx install state.`);
  }
  return {
    version: 1,
    installation_id: parsed.installation_id,
    created_at: parsed.created_at,
  };
}

export async function add(options: AddSkillOptions & RunxSdkOptions): Promise<InstallLocalSkillResult> {
  return await createRunxSdk(options).addSkill(options);
}

export async function publish(options: PublishSkillOptions & RunxSdkOptions): Promise<PublishSkillMarkdownResult> {
  return await createRunxSdk(options).publishSkill(options);
}

export async function connectList(options: RunxSdkOptions): Promise<unknown> {
  return await createRunxSdk(options).connectList();
}

export async function connectPreprovision(
  options: {
    readonly provider: string;
    readonly scopes?: readonly string[];
    readonly scope_family?: string;
    readonly authority_kind?: "read_only" | "constructive" | "destructive";
    readonly target_repo?: string;
    readonly target_locator?: string;
  } & RunxSdkOptions,
): Promise<unknown> {
  return await createRunxSdk(options).connectPreprovision(options);
}

export async function connectRevoke(options: { readonly grantId: string } & RunxSdkOptions): Promise<unknown> {
  return await createRunxSdk(options).connectRevoke(options.grantId);
}
