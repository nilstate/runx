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
  // Prefer the workspace source harness over any compiled dist when both are
  // reachable. A concurrent `pnpm build` (e.g. from cli-package.test.ts) can
  // rewrite the dist mid-spawn; the source path is stable. We make two passes
  // up from import.meta.url: first looking for the workspace source, then
  // (only if no workspace exists) falling back to the packaged build.
  const start = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  for (let current = start; ; current = path.dirname(current)) {
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
    if (path.dirname(current) === current) {
      break;
    }
  }
  for (let current = start; ; current = path.dirname(current)) {
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
    if (path.dirname(current) === current) {
      break;
    }
  }
  throw new Error("Could not locate the runx workspace root for the fixture MCP catalog.");
}
