import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpToolCatalogAdapter } from "./mcp.js";

const fixtureDirectory = resolveFixtureDirectory();

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

function resolveFixtureDirectory(): string {
  let current = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  while (true) {
    const candidate = path.join(current, "packages", "core", "src", "harness", "mcp-fixture.ts");
    if (fs.existsSync(candidate)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the runx workspace root for the fixture MCP catalog.");
    }
    current = parent;
  }
}
