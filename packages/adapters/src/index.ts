import type { SkillAdapter } from "@runxhq/core/executor";

import { createA2aAdapter, createFixtureA2aTransport } from "./a2a/index.js";
import { createCliToolAdapter } from "./cli-tool/index.js";
import { createMcpAdapter } from "./mcp/index.js";

export const adaptersPackage = "@runxhq/adapters";

export * from "./a2a/index.js";
export * from "./cli-tool/index.js";
export * from "./mcp/index.js";

export function createDefaultSkillAdapters(): readonly SkillAdapter[] {
  return [
    createCliToolAdapter(),
    createMcpAdapter(),
    createA2aAdapter({ transport: createFixtureA2aTransport() }),
  ];
}
