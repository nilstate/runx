export const sdkJsPackage = "@runxhq/core/sdk";

export * from "./caller.js";
export * from "./framework-adapters.js";

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
} from "../config/index.js";
import {
  createFixtureMarketplaceAdapter,
  searchMarketplaceAdapters,
  type MarketplaceAdapter,
  type SkillSearchResult,
} from "../marketplaces/index.js";
import { type LocalReceipt, type ReceiptVerification } from "../receipts/index.js";
import {
  createFileRegistryStore,
  createLocalRegistryClient,
  publishSkillMarkdown,
  searchRemoteRegistry,
  searchRegistry,
  type PublishSkillMarkdownOptions,
  type PublishSkillMarkdownResult,
  type RegistryStore,
} from "../registry/index.js";
import {
  installLocalSkill,
  inspectLocalReceipt,
  listLocalHistory,
  runLocalSkill,
  type AuthResolver,
  type Caller,
  type InstallLocalSkillResult,
  type RunLocalSkillResult,
} from "../runner-local/index.js";
import { validatePublishHarness, type PublishHarnessSummary } from "../harness/index.js";
import type { SkillAdapter } from "../executor/index.js";
import { createStructuredCaller, type StructuredCallerOptions } from "./caller.js";

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
      runxHome: options.runxHome ?? this.options.runxHome,
      parentReceipt: options.parentReceipt,
      contextFrom: options.contextFrom,
      allowedSourceTypes: options.allowedSourceTypes ?? this.options.allowedSourceTypes,
      authResolver: options.authResolver ?? this.options.authResolver,
      resumeFromRunId: options.resumeFromRunId,
      adapters: options.adapters ?? this.options.adapters,
      voiceProfilePath: options.voiceProfilePath ?? this.options.voiceProfilePath,
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

export async function runSkill(options: RunSkillOptions & RunxSdkOptions): Promise<RunLocalSkillResult> {
  return await createRunxSdk(options).runSkill(options);
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
  try {
    return JSON.parse(await readFile(path.join(globalHomeDir, "install.json"), "utf8")) as RunxInstallState;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
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
