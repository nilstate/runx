export const agentAdapterPackage = "@runxhq/adapters/agent";

import path from "node:path";

import {
  loadLocalAgentApiKey,
  loadRunxConfigFile,
  resolveRunxHomeDir,
} from "@runxhq/core/config";
import {
  type AdapterInvokeRequest,
  type AdapterInvokeResult,
  type CognitiveResolutionRequest,
  type NestedSkillInvoker,
  type ResolutionResponse,
  type SkillAdapter,
} from "@runxhq/core/executor";

import { resolveWithAnthropic } from "./anthropic.js";
import { resolveWithOpenAi } from "./openai.js";
import { resolveManagedRuntimeTools } from "./runtime-tools.js";
import { buildManagedAgentWorkRequest, nativeAgentMetadata } from "./work-request.js";

export type ManagedAgentProvider = "openai" | "anthropic";

export interface ManagedAgentConfig {
  readonly provider: ManagedAgentProvider;
  readonly model: string;
  readonly apiKey: string;
}

export async function loadManagedAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManagedAgentConfig | undefined> {
  const configDir = resolveRunxHomeDir(env);
  const config = await loadRunxConfigFile(path.join(configDir, "config.json"));
  const provider = normalizeManagedAgentProvider(env.RUNX_AGENT_PROVIDER ?? config.agent?.provider);
  if (!provider) {
    return undefined;
  }

  const model = String(env.RUNX_AGENT_MODEL ?? config.agent?.model ?? "").trim();
  if (!model) {
    return undefined;
  }

  const providerApiKey = provider === "openai"
    ? env.OPENAI_API_KEY
    : env.ANTHROPIC_API_KEY;
  const apiKey =
    String(env.RUNX_AGENT_API_KEY ?? providerApiKey ?? "").trim()
    || (
      typeof config.agent?.api_key_ref === "string" && config.agent.api_key_ref.length > 0
        ? (await loadLocalAgentApiKey(configDir, config.agent.api_key_ref)).trim()
        : ""
    );
  if (!apiKey) {
    return undefined;
  }

  return {
    provider,
    model,
    apiKey,
  };
}

export function formatManagedAgentLabel(config: ManagedAgentConfig): string {
  return `${config.provider === "openai" ? "OpenAI" : "Anthropic"} ${config.model}`;
}

export function createManagedAgentAdapter(config: ManagedAgentConfig): SkillAdapter {
  return {
    type: "agent",
    invoke: async (request) => await invokeManagedAgentAdapter(config, request, "agent"),
  };
}

export function createManagedAgentStepAdapter(config: ManagedAgentConfig): SkillAdapter {
  return {
    type: "agent-step",
    invoke: async (request) => await invokeManagedAgentAdapter(config, request, "agent-step"),
  };
}

export async function executeManagedAgentResolution(
  config: ManagedAgentConfig,
  request: CognitiveResolutionRequest,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly searchFromDirectory?: string;
    readonly nestedSkillInvoker?: NestedSkillInvoker;
  } = {},
): Promise<ResolutionResponse> {
  const execution = await executeManagedAgentRequest(config, request, options);
  if ("request" in execution) {
    throw new Error(
      `Managed agent resolution for ${request.id} paused on nested ${execution.request.kind} resolution, which is not supported on the direct caller path.`,
    );
  }
  return execution.response;
}

async function invokeManagedAgentAdapter(
  config: ManagedAgentConfig,
  request: AdapterInvokeRequest,
  sourceType: "agent" | "agent-step",
): Promise<AdapterInvokeResult> {
  const startedAt = Date.now();
  const env = request.env ?? process.env;
  const work = buildManagedAgentWorkRequest(request, sourceType);

  try {
    const execution = await executeManagedAgentRequest(
      config,
      {
        id: work.id,
        kind: "cognitive_work",
        work,
      },
      {
        env,
        signal: request.signal,
        searchFromDirectory: request.skillDirectory,
        nestedSkillInvoker: request.nestedSkillInvoker,
        allowPauseOnNestedResolution: true,
        toolCatalogAdapters: request.toolCatalogAdapters,
      },
    );

    if ("request" in execution) {
      return {
        status: "needs_resolution",
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        request: execution.request,
        metadata: nativeAgentMetadata(sourceType, request, config, execution, "paused"),
      };
    }

    return {
      status: "success",
      stdout: typeof execution.response.payload === "string"
        ? execution.response.payload
        : JSON.stringify(execution.response.payload),
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: Date.now() - startedAt,
      metadata: nativeAgentMetadata(sourceType, request, config, execution, "success"),
    };
  } catch (error) {
    return {
      status: "failure",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      metadata: nativeAgentMetadata(sourceType, request, config, undefined, "failure"),
    };
  }
}

async function executeManagedAgentRequest(
  config: ManagedAgentConfig,
  request: CognitiveResolutionRequest,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly searchFromDirectory?: string;
    readonly nestedSkillInvoker?: NestedSkillInvoker;
    readonly allowPauseOnNestedResolution?: boolean;
    readonly toolCatalogAdapters?: AdapterInvokeRequest["toolCatalogAdapters"];
  } = {},
) {
  const env = options.env ?? process.env;
  const searchFromDirectory = path.resolve(
    options.searchFromDirectory
      ?? request.work.envelope.execution_location?.skill_directory
      ?? env.RUNX_CWD
      ?? process.cwd(),
  );
  const runtimeTools = await resolveManagedRuntimeTools(
    request.work.envelope.allowed_tools,
    searchFromDirectory,
    env,
    options.signal,
    request.work.envelope.execution_location?.tool_roots,
    options.nestedSkillInvoker,
    options.toolCatalogAdapters,
  );

  if (config.provider === "anthropic") {
    return await resolveWithAnthropic(
      config,
      request,
      runtimeTools,
      options.signal,
      options.allowPauseOnNestedResolution === true,
    );
  }
  return await resolveWithOpenAi(
    config,
    request,
    runtimeTools,
    options.signal,
    options.allowPauseOnNestedResolution === true,
  );
}

function normalizeManagedAgentProvider(value: unknown): ManagedAgentProvider | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "openai" || normalized === "anthropic" ? normalized : undefined;
}
