import type {
  HostBoundaryResolver,
  HostBridge,
  HostRunOptions,
  HostRunResult,
} from "@runxhq/runtime-local/sdk";

export interface OpenAIHostResponse {
  readonly role: "tool";
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: {
    readonly runx: HostRunResult;
  };
}

export interface AnthropicHostResponse {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly metadata: {
    readonly runx: HostRunResult;
  };
}

export interface VercelAiHostResponse {
  readonly messages: readonly [{ readonly role: "assistant"; readonly content: string }];
  readonly data: {
    readonly runx: HostRunResult;
  };
}

export interface LangChainHostResponse {
  readonly content: string;
  readonly additional_kwargs: {
    readonly runx: HostRunResult;
  };
}

export interface CrewAiHostResponse {
  readonly raw: string;
  readonly json_dict: {
    readonly runx: HostRunResult;
  };
}

export interface ProviderHostAdapter<TResponse> {
  readonly run: (
    options: HostRunOptions & {
      readonly resolver?: HostBoundaryResolver;
    },
  ) => Promise<TResponse>;
  readonly resume: (
    runId: string,
    options: Omit<HostRunOptions, "resumeFromRunId" | "skillPath"> & {
      readonly skillPath?: string;
      readonly resolver?: HostBoundaryResolver;
    },
  ) => Promise<TResponse>;
}

export function createOpenAiHostAdapter(bridge: HostBridge): ProviderHostAdapter<OpenAIHostResponse> {
  return {
    run: async (options) => toOpenAiResponse(await bridge.run(options)),
    resume: async (runId, options) => toOpenAiResponse(await bridge.resume(runId, options)),
  };
}

export function createAnthropicHostAdapter(bridge: HostBridge): ProviderHostAdapter<AnthropicHostResponse> {
  return {
    run: async (options) => toAnthropicResponse(await bridge.run(options)),
    resume: async (runId, options) => toAnthropicResponse(await bridge.resume(runId, options)),
  };
}

export function createVercelAiHostAdapter(bridge: HostBridge): ProviderHostAdapter<VercelAiHostResponse> {
  return {
    run: async (options) => toVercelAiResponse(await bridge.run(options)),
    resume: async (runId, options) => toVercelAiResponse(await bridge.resume(runId, options)),
  };
}

export function createLangChainHostAdapter(bridge: HostBridge): ProviderHostAdapter<LangChainHostResponse> {
  return {
    run: async (options) => toLangChainResponse(await bridge.run(options)),
    resume: async (runId, options) => toLangChainResponse(await bridge.resume(runId, options)),
  };
}

export function createCrewAiHostAdapter(bridge: HostBridge): ProviderHostAdapter<CrewAiHostResponse> {
  return {
    run: async (options) => toCrewAiResponse(await bridge.run(options)),
    resume: async (runId, options) => toCrewAiResponse(await bridge.resume(runId, options)),
  };
}

function toOpenAiResponse(result: HostRunResult): OpenAIHostResponse {
  return {
    role: "tool",
    content: [{ type: "text", text: summarizeHostResult(result) }],
    structuredContent: { runx: result },
  };
}

function toAnthropicResponse(result: HostRunResult): AnthropicHostResponse {
  return {
    content: [{ type: "text", text: summarizeHostResult(result) }],
    metadata: { runx: result },
  };
}

function toVercelAiResponse(result: HostRunResult): VercelAiHostResponse {
  return {
    messages: [{ role: "assistant", content: summarizeHostResult(result) }],
    data: { runx: result },
  };
}

function toLangChainResponse(result: HostRunResult): LangChainHostResponse {
  return {
    content: summarizeHostResult(result),
    additional_kwargs: { runx: result },
  };
}

function toCrewAiResponse(result: HostRunResult): CrewAiHostResponse {
  return {
    raw: summarizeHostResult(result),
    json_dict: { runx: result },
  };
}

function summarizeHostResult(result: HostRunResult): string {
  switch (result.status) {
    case "completed":
      return `${result.skillName} completed. Inspect receipt ${result.receiptId}.`;
    case "paused":
      return `${result.skillName} paused at ${result.runId}. Resume after resolving ${result.requests.length} request(s).`;
    case "denied":
      return `${result.skillName} was denied by policy.`;
    case "escalated":
      return `${result.skillName} escalated. Inspect receipt ${result.receiptId}.`;
    case "failed":
      return `${result.skillName} failed. Inspect receipt ${result.receiptId ?? "n/a"}.`;
    default:
      return assertNever(result);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled host run result: ${JSON.stringify(value)}`);
}
