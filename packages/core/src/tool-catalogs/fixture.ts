import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpToolCatalogAdapter } from "./mcp.js";

const fixtureDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export function createFixtureMcpToolCatalogAdapter(): ReturnType<typeof createMcpToolCatalogAdapter> {
  return createMcpToolCatalogAdapter({
    source: "fixture-mcp",
    label: "Fixture MCP Catalog",
    namespace: "fixture",
    baseDirectory: fixtureDirectory,
    server: {
      command: "node",
      args: [
        "--import",
        "tsx",
        "packages/core/src/harness/mcp-fixture.ts",
      ],
      cwd: ".",
    },
    tags: ["fixture", "mcp"],
  });
}
