import { createFixtureMcpToolCatalogAdapter } from "./fixture.js";

export const runtimeLocalToolCatalogsPackage = "@runxhq/runtime-local/tool-catalogs";

export {
  createImportedTool,
  createToolInspectResult,
  inspectCatalogResolvedTool,
  resolveCatalogTool,
  searchToolCatalogAdapters,
  type ToolCatalogAdapter,
  type ToolCatalogInvokeRequest,
  type ToolCatalogInvokeResult,
  type ToolCatalogResolvedTool,
  type ToolCatalogSearchOptions,
  type ToolCatalogSearchResult,
  type ToolInspectProvenance,
  type ToolInspectResult,
} from "@runxhq/core/tool-catalogs";
export { createMcpToolCatalogAdapter, type McpToolCatalogAdapterOptions } from "./mcp.js";
export { createFixtureMcpToolCatalogAdapter } from "./fixture.js";

export function resolveEnvToolCatalogAdapters(
  env: NodeJS.ProcessEnv = process.env,
  source?: string,
): readonly import("@runxhq/core/tool-catalogs").ToolCatalogAdapter[] {
  const normalizedSource = source?.trim().toLowerCase();
  if (
    env.RUNX_ENABLE_FIXTURE_TOOL_CATALOG === "1"
    && (!normalizedSource || normalizedSource === "catalog" || normalizedSource === "fixture-mcp")
  ) {
    return [createFixtureMcpToolCatalogAdapter()];
  }
  return [];
}
