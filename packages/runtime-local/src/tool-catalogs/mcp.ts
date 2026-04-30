import { errorMessage } from "@runxhq/core/util";

import {
  createMcpExecutionMetadata,
  invokeMcpTool,
  listMcpTools,
  mapMcpArguments,
  stringifyMcpToolResult,
  type McpServerDefinition,
  type McpToolDescriptor,
} from "../mcp/index.js";
import type { ToolCatalogAdapter, ToolCatalogResolvedTool, ToolCatalogSearchResult } from "./index.js";

import { createImportedTool } from "./index.js";

export interface McpToolCatalogAdapterOptions {
  readonly source: string;
  readonly label: string;
  readonly namespace: string;
  readonly server: McpServerDefinition;
  readonly baseDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly tags?: readonly string[];
}

export function createMcpToolCatalogAdapter(options: McpToolCatalogAdapterOptions): ToolCatalogAdapter {
  let cachedToolsPromise: Promise<readonly ImportedMcpTool[]> | undefined;

  async function loadImportedTools(env: NodeJS.ProcessEnv | undefined): Promise<readonly ImportedMcpTool[]> {
    if (!cachedToolsPromise) {
      cachedToolsPromise = loadMcpTools(options, env);
    }
    return await cachedToolsPromise;
  }

  return {
    source: options.source,
    label: options.label,
    search: async (query, searchOptions = {}) => {
      const normalizedQuery = query.trim().toLowerCase();
      const tools = await loadImportedTools(options.env);
      return tools
        .map((entry) => entry.result)
        .filter((result) => normalizedQuery.length === 0 || searchableText(result).includes(normalizedQuery))
        .slice(0, searchOptions.limit ?? 20);
    },
    resolve: async (ref, resolveOptions = {}) => {
      const tools = await loadImportedTools(resolveOptions.env ?? options.env);
      const normalizedRef = ref.trim().toLowerCase();
      return tools.find((entry) => matchesImportedTool(entry, normalizedRef));
    },
  };
}

interface ImportedMcpTool extends ToolCatalogResolvedTool {
  readonly externalName: string;
}

async function loadMcpTools(
  options: McpToolCatalogAdapterOptions,
  env: NodeJS.ProcessEnv | undefined,
): Promise<readonly ImportedMcpTool[]> {
  const listedTools = await listMcpTools({
    server: options.server,
    skillDirectory: options.baseDirectory,
    env: env ?? options.env,
    timeoutMs: options.timeoutMs,
  });
  return listedTools.map((listed) => importedToolFromMcpDescriptor(options, listed));
}

function importedToolFromMcpDescriptor(
  options: McpToolCatalogAdapterOptions,
  listed: McpToolDescriptor,
): ImportedMcpTool {
  const imported = createImportedTool({
    name: listed.name,
    description: listed.description,
    namespace: options.namespace,
    externalName: listed.name,
    source: options.source,
    sourceLabel: options.label,
    sourceType: "mcp",
    inputSchema: listed.inputSchema,
    tags: options.tags,
  });

  return {
    ...imported,
    externalName: listed.name,
    skillDirectory: options.baseDirectory,
    referencePath: `catalog:${options.source}:${imported.result.name}`,
    invoke: async (request) => {
      try {
        const result = await invokeMcpTool({
          server: options.server,
          skillDirectory: options.baseDirectory,
          env: request.env ?? options.env,
          timeoutMs: options.timeoutMs,
          tool: listed.name,
          args: mapMcpArguments(undefined, request.inputs, request.resolvedInputs),
        });
        return {
          status: "success",
          stdout: stringifyMcpToolResult(result),
          metadata: createMcpExecutionMetadata({
            server: options.server,
            tool: listed.name,
          }),
        } as const;
      } catch (error) {
        const message = errorMessage(error);
        return {
          status: "failure",
          stdout: "",
          stderr: message,
          errorMessage: message,
          metadata: createMcpExecutionMetadata({
            server: options.server,
            tool: listed.name,
          }),
        } as const;
      }
    },
  };
}

function matchesImportedTool(entry: ImportedMcpTool, ref: string): boolean {
  return [
    entry.result.name.toLowerCase(),
    entry.result.tool_id.toLowerCase(),
    entry.result.catalog_ref.toLowerCase(),
    `${entry.result.source}:${entry.result.name}`,
    `${entry.result.namespace}.${entry.externalName}`.toLowerCase(),
    entry.externalName.toLowerCase(),
  ].map((value) => value.toLowerCase()).includes(ref);
}

function searchableText(result: ToolCatalogSearchResult): string {
  return [
    result.tool_id,
    result.name,
    result.summary,
    result.source,
    result.source_label,
    result.source_type,
    result.namespace,
    result.external_name,
    result.catalog_ref,
    ...result.tags,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}
