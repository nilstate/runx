import {
  executeManagedAgentResolution,
  formatManagedAgentLabel,
  loadManagedAgentConfig,
  type ManagedAgentConfig,
} from "@runxhq/adapters/agent";
import type { ResolutionRequest, ResolutionResponse } from "@runxhq/core/executor";

type CognitiveResolutionRequest = Extract<ResolutionRequest, { readonly kind: "cognitive_work" }>;

export interface CliAgentRuntime {
  readonly label: string;
  readonly resolve: (request: CognitiveResolutionRequest) => Promise<ResolutionResponse>;
}

export async function loadCliAgentRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliAgentRuntime | undefined> {
  const config = await loadManagedAgentConfig(env);
  if (!config) {
    return undefined;
  }
  return createCliAgentRuntime(config, env);
}

function createCliAgentRuntime(
  config: ManagedAgentConfig,
  env: NodeJS.ProcessEnv,
): CliAgentRuntime {
  return {
    label: formatManagedAgentLabel(config),
    resolve: async (request) =>
      await executeManagedAgentResolution(config, request, {
        env,
      }),
  };
}
