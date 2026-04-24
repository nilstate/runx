import type { SkillAdapter } from "@runxhq/core/executor";

import { createA2aAdapter, createFixtureA2aTransport } from "./a2a/index.js";
import { createCatalogAdapter } from "./catalog/index.js";
import {
  createManagedAgentAdapter,
  createManagedAgentStepAdapter,
  loadManagedAgentConfig,
} from "./agent/index.js";
import { createCliToolAdapter } from "./cli-tool/index.js";
import { createMcpAdapter } from "./mcp/index.js";

export const adaptersPackage = "@runxhq/adapters";

export * from "./a2a/index.js";
export * from "./catalog/index.js";
export * from "./agent/index.js";
export * from "./cli-tool/index.js";
export * from "./mcp/index.js";
export * from "./runtime.js";

export function createDefaultSkillAdapters(): readonly SkillAdapter[] {
  return [
    createCatalogAdapter(),
    createCliToolAdapter(),
    createMcpAdapter(),
    createA2aAdapter({ transport: createFixtureA2aTransport() }),
  ];
}

export async function resolveDefaultSkillAdapters(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readonly includeManagedAgents?: boolean;
  } = {},
): Promise<readonly SkillAdapter[]> {
  const baseAdapters = createDefaultSkillAdapters();
  if (options.includeManagedAgents === false) {
    return baseAdapters;
  }

  const managed = await loadManagedAgentConfig(env);
  if (!managed) {
    return baseAdapters;
  }

  return [
    createManagedAgentAdapter(managed),
    createManagedAgentStepAdapter(managed),
    ...baseAdapters,
  ];
}
