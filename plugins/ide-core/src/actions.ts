import { createDefaultSkillAdapters } from "@runxhq/adapters";
import { runHarness, type HarnessRunResult } from "@runxhq/core/harness";
import {
  createRunxSdk,
  createStructuredCaller,
  type AddSkillOptions,
  type ConnectService,
  type HistoryOptions,
  type RunSkillOptions,
  type RunxSdk,
  type RunxSdkOptions,
  type SearchSkillsOptions,
  type StructuredCaller,
} from "@runxhq/core/sdk";

export interface IdeActionCoreOptions extends RunxSdkOptions {
  readonly sdk?: RunxSdk;
}

export interface IdeActionResult<T = unknown> {
  readonly action: string;
  readonly status: "success" | "needs_resolution" | "policy_denied" | "failure" | "error";
  readonly data?: T;
  readonly resolutions: readonly unknown[];
  readonly events: readonly unknown[];
  readonly error?: string;
}

export interface IdeActionCore {
  readonly runSkill: (options: RunSkillOptions) => Promise<IdeActionResult>;
  readonly inspectReceipt: (receiptId: string, options?: { readonly receiptDir?: string }) => Promise<IdeActionResult>;
  readonly history: (options?: HistoryOptions) => Promise<IdeActionResult>;
  readonly searchSkills: (options: SearchSkillsOptions) => Promise<IdeActionResult>;
  readonly addSkill: (options: AddSkillOptions) => Promise<IdeActionResult>;
  readonly connectList: () => Promise<IdeActionResult>;
  readonly connectPreprovision: (request: {
    readonly provider: string;
    readonly scopes?: readonly string[];
    readonly scope_family?: string;
    readonly authority_kind?: "read_only" | "constructive" | "destructive";
    readonly target_repo?: string;
    readonly target_locator?: string;
  }) => Promise<IdeActionResult>;
  readonly connectRevoke: (grantId: string) => Promise<IdeActionResult>;
  readonly harnessRun: (fixturePath: string) => Promise<IdeActionResult<HarnessRunResult>>;
}

export function createIdeActionCore(options: IdeActionCoreOptions = {}): IdeActionCore {
  const adapters = options.adapters ?? createDefaultSkillAdapters();
  const sdk = options.sdk ?? createRunxSdk({ ...options, adapters });
  return {
    runSkill: async (runOptions) => withStructuredCaller("runx.skill.run", async (caller) => await sdk.runSkill({ ...runOptions, caller })),
    inspectReceipt: async (receiptId, inspectOptions = {}) =>
      wrapAction("runx.receipt.inspect", async () => await sdk.inspectReceipt({ receiptId, receiptDir: inspectOptions.receiptDir })),
    history: async (historyOptions = {}) => wrapAction("runx.history", async () => await sdk.history(historyOptions)),
    searchSkills: async (searchOptions) => wrapAction("runx.skill.search", async () => await sdk.searchSkills(searchOptions)),
    addSkill: async (addOptions) => wrapAction("runx.skill.add", async () => await sdk.addSkill(addOptions)),
    connectList: async () => wrapAction("runx.connect.list", async () => await sdk.connectList()),
    connectPreprovision: async (request) =>
      wrapAction("runx.connect.preprovision", async () => await sdk.connectPreprovision(request)),
    connectRevoke: async (grantId) => wrapAction("runx.connect.revoke", async () => await sdk.connectRevoke(grantId)),
    harnessRun: async (fixturePath) => wrapAction("runx.harness.run", async () => await runHarness(fixturePath, { env: options.env, adapters })),
  };
}

export function createFixtureConnectService(): ConnectService {
  return {
    list: async () => ({ grants: [] }),
    preprovision: async (request) => ({ status: "created", grant: { provider: request.provider, scopes: request.scopes } }),
    revoke: async (grantId) => ({ status: "revoked", grant: { grant_id: grantId } }),
  };
}

async function withStructuredCaller<T>(
  action: string,
  run: (caller: StructuredCaller) => Promise<T>,
): Promise<IdeActionResult<T>> {
  const caller = createStructuredCaller();
  return await wrapAction(action, async () => await run(caller), caller);
}

async function wrapAction<T>(
  action: string,
  run: () => Promise<T>,
  caller?: StructuredCaller,
): Promise<IdeActionResult<T>> {
  try {
    const data = await run();
    return {
      action,
      status: normalizeStatus(isRecord(data) && typeof data.status === "string" ? data.status : undefined),
      data,
      resolutions: caller?.trace.resolutions ?? [],
      events: caller?.trace.events ?? [],
    };
  } catch (error) {
    return {
      action,
      status: "error",
      resolutions: caller?.trace.resolutions ?? [],
      events: caller?.trace.events ?? [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeStatus(status: string | undefined): IdeActionResult["status"] {
  if (status === "success" || status === "needs_resolution" || status === "policy_denied" || status === "failure") {
    return status;
  }
  return "success";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
