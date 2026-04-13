export const sdkJsPackage = "@runx/sdk";

export * from "./caller.js";

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createFixtureMarketplaceAdapter,
  searchMarketplaceAdapters,
  type MarketplaceAdapter,
  type SkillSearchResult,
} from "../../marketplaces/src/index.js";
import { type LocalReceipt, type ReceiptVerification } from "../../receipts/src/index.js";
import {
  createFileRegistryStore,
  createLocalRegistryClient,
  publishSkillMarkdown,
  searchRegistry,
  type PublishSkillMarkdownOptions,
  type PublishSkillMarkdownResult,
  type RegistryStore,
} from "../../registry/src/index.js";
import {
  installLocalSkill,
  inspectLocalReceipt,
  listLocalHistory,
  runLocalSkill,
  type AuthResolver,
  type Caller,
  type InstallLocalSkillResult,
  type RunLocalSkillResult,
} from "../../runner-local/src/index.js";
import { createStructuredCaller, type StructuredCallerOptions } from "./caller.js";

export interface ConnectService {
  readonly list: () => Promise<unknown>;
  readonly preprovision: (provider: string, scopes: readonly string[]) => Promise<unknown>;
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
      skillPath: resolveUserPath(options.skillPath, this.env()),
      inputs: options.inputs,
      answersPath: options.answersPath ? resolveUserPath(options.answersPath, this.env()) : undefined,
      caller: this.caller(options.caller),
      env: this.env(),
      receiptDir: this.receiptDir(options.receiptDir),
      runxHome: options.runxHome ?? this.options.runxHome,
      parentReceipt: options.parentReceipt,
      contextFrom: options.contextFrom,
      allowedSourceTypes: options.allowedSourceTypes ?? this.options.allowedSourceTypes,
      authResolver: options.authResolver ?? this.options.authResolver,
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
      results.push(
        ...(await searchRegistry(this.registryStore(), options.query, {
          limit: options.limit,
          registryUrl: this.options.registryUrl ?? this.env().RUNX_REGISTRY_URL,
        })),
      );
    }

    const marketplaceAdapters = this.marketplaceAdapters(normalizedSource);
    results.push(...(await searchMarketplaceAdapters(marketplaceAdapters, options.query, { limit: options.limit })));

    return results.slice(0, options.limit ?? 20);
  }

  async addSkill(options: AddSkillOptions): Promise<InstallLocalSkillResult> {
    return await installLocalSkill({
      ref: options.ref,
      registryStore: this.registryStore(options.registryUrl),
      marketplaceAdapters: this.marketplaceAdapters(),
      destinationRoot: options.to ? resolveUserPath(options.to, this.env()) : defaultSkillInstallRoot(this.env()),
      version: options.version,
      expectedDigest: options.expectedDigest,
      registryUrl: options.registryUrl ?? this.options.registryUrl,
    });
  }

  async publishSkill(options: PublishSkillOptions): Promise<PublishSkillMarkdownResult> {
    const skillPackage = await readSkillPackage(resolveUserPath(options.skillPath, this.env()));
    return await publishSkillMarkdown(createLocalRegistryClient(this.registryStore(options.registryUrl)), skillPackage.markdown, {
      owner: options.owner,
      version: options.version,
      createdAt: options.createdAt,
      registryUrl: options.registryUrl ?? this.options.registryUrl,
      xManifest: skillPackage.xManifest,
    });
  }

  async connectList(): Promise<unknown> {
    return await this.requireConnect().list();
  }

  async connectPreprovision(provider: string, scopes: readonly string[] = []): Promise<unknown> {
    return await this.requireConnect().preprovision(provider, scopes);
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
    return resolveUserPath(
      override ?? this.options.receiptDir ?? this.env().RUNX_RECEIPT_DIR ?? path.join(defaultRunxDir(this.env()), "receipts"),
      this.env(),
    );
  }

  private registryStore(registryUrl = this.options.registryUrl): RegistryStore {
    return this.options.registryStore ?? createFileRegistryStore(resolveRegistryDir(this.env(), registryUrl, this.options.registryDir));
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
  options: { readonly provider: string; readonly scopes?: readonly string[] } & RunxSdkOptions,
): Promise<unknown> {
  return await createRunxSdk(options).connectPreprovision(options.provider, options.scopes ?? []);
}

export async function connectRevoke(options: { readonly grantId: string } & RunxSdkOptions): Promise<unknown> {
  return await createRunxSdk(options).connectRevoke(options.grantId);
}

function resolveRegistryDir(env: NodeJS.ProcessEnv, registry?: string, registryDir?: string): string {
  if (registry && isRemoteRegistryUrl(registry) && !env.RUNX_REGISTRY_DIR && !registryDir) {
    throw new Error("Remote registry transport is not implemented in CE; set RUNX_REGISTRY_DIR for local-backed registry tests.");
  }
  if (registry && !isRemoteRegistryUrl(registry)) {
    return registry.startsWith("file://") ? fileURLToPath(registry) : resolveUserPath(registry, env);
  }
  if (registryDir) {
    return resolveUserPath(registryDir, env);
  }
  return env.RUNX_REGISTRY_DIR
    ? resolveUserPath(env.RUNX_REGISTRY_DIR, env)
    : path.join(defaultRunxDir(env), "registry");
}

function isRemoteRegistryUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function defaultSkillInstallRoot(env: NodeJS.ProcessEnv): string {
  return path.resolve(env.RUNX_CWD ?? findWorkspaceRoot(process.cwd()) ?? env.INIT_CWD ?? process.cwd(), "skills");
}

interface LocalSkillPackage {
  readonly markdown: string;
  readonly xManifest?: string;
}

async function readSkillPackage(skillPath: string): Promise<LocalSkillPackage> {
  const resolvedPath = path.resolve(skillPath);
  const pathStat = await stat(resolvedPath);
  const markdownPath = pathStat.isDirectory() ? path.join(resolvedPath, "SKILL.md") : resolvedPath;
  if (path.basename(markdownPath).toLowerCase() !== "skill.md") {
    throw new Error(
      `Skill packages must be referenced by directory or SKILL.md. Flat markdown files are not supported: ${resolvedPath}`,
    );
  }
  if (!existsSync(markdownPath)) {
    throw new Error(`Skill package '${resolvedPath}' is missing SKILL.md.`);
  }
  const xManifestPath = pathStat.isDirectory()
    ? path.join(resolvedPath, "x.yaml")
    : path.join(path.dirname(resolvedPath), "x.yaml");
  return {
    markdown: await readFile(markdownPath, "utf8"),
    xManifest: await readOptionalFile(xManifestPath),
  };
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function defaultRunxDir(env: NodeJS.ProcessEnv): string {
  return path.resolve(env.RUNX_CWD ?? findWorkspaceRoot(process.cwd()) ?? env.INIT_CWD ?? process.cwd(), ".runx");
}

function resolveUserPath(userPath: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(userPath)) {
    return userPath;
  }

  for (const base of [env.RUNX_CWD, env.INIT_CWD, findWorkspaceRoot(process.cwd()), process.cwd()]) {
    if (!base) {
      continue;
    }
    const candidate = path.resolve(base, userPath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return path.resolve(env.RUNX_CWD ?? findWorkspaceRoot(process.cwd()) ?? env.INIT_CWD ?? process.cwd(), userPath);
}

function findWorkspaceRoot(start: string): string | undefined {
  let current = start;
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}
