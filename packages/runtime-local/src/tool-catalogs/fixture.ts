import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServerDefinition } from "../mcp/index.js";
import { createMcpToolCatalogAdapter } from "./mcp.js";

export function createFixtureMcpToolCatalogAdapter(): ReturnType<typeof createMcpToolCatalogAdapter> {
  const runtime = resolveFixtureRuntime();
  return createMcpToolCatalogAdapter({
    source: "fixture-mcp",
    label: "Fixture MCP Catalog",
    namespace: "fixture",
    baseDirectory: runtime.baseDirectory,
    server: runtime.server,
    tags: ["fixture", "mcp"],
  });
}

function resolveFixtureRuntime(): {
  readonly baseDirectory: string;
  readonly server: McpServerDefinition;
} {
  let current = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  while (true) {
    const workspaceHarness = path.join(current, "packages", "runtime-local", "src", "harness", "mcp-fixture.ts");
    if (fs.existsSync(workspaceHarness)) {
      return {
        baseDirectory: current,
        server: {
          command: "node",
          args: [
            "--import",
            "tsx",
            "packages/runtime-local/src/harness/mcp-fixture.ts",
          ],
          cwd: current,
        },
      };
    }
    const packagedHarness = path.join(current, "dist", "src", "harness", "mcp-fixture.js");
    if (fs.existsSync(packagedHarness)) {
      return {
        baseDirectory: current,
        server: {
          command: "node",
          args: [packagedHarness],
          cwd: current,
        },
      };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the runx workspace root for the fixture MCP catalog.");
    }
    current = parent;
  }
}
