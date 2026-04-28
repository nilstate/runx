import { asRecord, hashString } from "@runxhq/core/util";

import { createFixtureMcpToolCatalogAdapter } from "./fixture.js";
import {
  validateToolManifest,
  type SkillInput,
  type SkillSource,
  type ValidatedTool,
} from "@runxhq/core/parser";
import type {
  ToolCatalogAdapter,
  ToolCatalogResolvedTool,
  ToolCatalogSearchOptions,
  ToolCatalogSearchResult,
  ToolInspectProvenance,
  ToolInspectResult,
} from "@runxhq/core/executor";

export const runtimeLocalToolCatalogsPackage = "@runxhq/runtime-local/tool-catalogs";

export type {
  ToolCatalogAdapter,
  ToolCatalogInvokeRequest,
  ToolCatalogInvokeResult,
  ToolCatalogResolvedTool,
  ToolCatalogSearchOptions,
  ToolCatalogSearchResult,
  ToolInspectProvenance,
  ToolInspectResult,
} from "@runxhq/core/executor";
export { createMcpToolCatalogAdapter, type McpToolCatalogAdapterOptions } from "./mcp.js";
export { createFixtureMcpToolCatalogAdapter } from "./fixture.js";

export function resolveEnvToolCatalogAdapters(
  env: NodeJS.ProcessEnv = process.env,
  source?: string,
): readonly ToolCatalogAdapter[] {
  const normalizedSource = source?.trim().toLowerCase();
  if (
    env.RUNX_ENABLE_FIXTURE_TOOL_CATALOG === "1"
    && (!normalizedSource || normalizedSource === "catalog" || normalizedSource === "fixture-mcp")
  ) {
    return [createFixtureMcpToolCatalogAdapter()];
  }
  return [];
}

export async function searchToolCatalogAdapters(
  adapters: readonly ToolCatalogAdapter[],
  query: string,
  options: ToolCatalogSearchOptions = {},
): Promise<readonly ToolCatalogSearchResult[]> {
  const results = await Promise.all(adapters.map((adapter) => adapter.search(query, options)));
  return results.flat().slice(0, options.limit ?? 20);
}

export async function resolveCatalogTool(
  adapters: readonly ToolCatalogAdapter[],
  ref: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly searchFromDirectory?: string;
  } = {},
): Promise<ToolCatalogResolvedTool | undefined> {
  const normalizedRef = normalizeCatalogRef(ref);
  for (const adapter of adapters) {
    const resolved = await adapter.resolve?.(normalizedRef, options);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

export function createToolInspectResult(options: {
  readonly ref: string;
  readonly tool: ValidatedTool;
  readonly referencePath: string;
  readonly skillDirectory: string;
  readonly provenance: ToolInspectProvenance;
}): ToolInspectResult {
  return {
    ref: options.ref,
    name: options.tool.name,
    description: options.tool.description,
    execution_source_type: options.tool.source.type,
    inputs: options.tool.inputs,
    scopes: options.tool.scopes,
    mutating: options.tool.mutating,
    runtime: options.tool.runtime,
    risk: options.tool.risk,
    runx: options.tool.runx,
    reference_path: options.referencePath,
    skill_directory: options.skillDirectory,
    provenance: options.provenance,
  };
}

export function inspectCatalogResolvedTool(ref: string, resolved: ToolCatalogResolvedTool): ToolInspectResult {
  return createToolInspectResult({
    ref,
    tool: resolved.tool,
    referencePath: resolved.referencePath,
    skillDirectory: resolved.skillDirectory,
    provenance: {
      origin: "imported",
      source: resolved.result.source,
      source_label: resolved.result.source_label,
      source_type: resolved.result.source_type,
      namespace: resolved.result.namespace,
      external_name: resolved.result.external_name,
      catalog_ref: resolved.result.catalog_ref,
      tool_id: resolved.result.tool_id,
      tags: resolved.result.tags,
    },
  });
}

export function createImportedTool(options: {
  readonly name: string;
  readonly description?: string;
  readonly namespace: string;
  readonly externalName: string;
  readonly source: string;
  readonly sourceLabel: string;
  readonly sourceType: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly scopes?: readonly string[];
  readonly tags?: readonly string[];
}): {
  readonly tool: ValidatedTool;
  readonly result: ToolCatalogSearchResult;
} {
  const qualifiedName = `${options.namespace}.${options.name}`;
  const scopes = options.scopes ?? [qualifiedName];
  const catalogRef = `${options.source}:${qualifiedName}`;
  const document = {
    name: qualifiedName,
    description: options.description,
    source: skillSourceToRaw({
      type: "catalog",
      args: [],
      catalogRef,
      raw: {
        type: "catalog",
        catalog_ref: catalogRef,
      },
    }),
    inputs: jsonSchemaToToolInputs(options.inputSchema),
    scopes,
    runx: {
      imported_from: {
        source: options.source,
        source_label: options.sourceLabel,
        source_type: options.sourceType,
        namespace: options.namespace,
        external_name: options.externalName,
        digest: hashString(JSON.stringify({
          source: options.source,
          namespace: options.namespace,
          external_name: options.externalName,
          source_type: options.sourceType,
        })),
      },
    },
  };

  return {
    tool: validateToolManifest({
      document,
      raw: `${JSON.stringify(document, null, 2)}\n`,
    }),
    result: {
      tool_id: `${options.source}/${qualifiedName}`,
      name: qualifiedName,
      summary: options.description,
      source: options.source,
      source_label: options.sourceLabel,
      source_type: options.sourceType,
      namespace: options.namespace,
      external_name: options.externalName,
      required_scopes: scopes,
      tags: options.tags ?? [options.sourceType],
      catalog_ref: catalogRef,
    },
  };
}

function jsonSchemaToToolInputs(inputSchema: Readonly<Record<string, unknown>> | undefined): Record<string, SkillInput> {
  const schema = asRecord(inputSchema);
  const properties = asRecord(schema?.properties);
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
  const inputs: Record<string, SkillInput> = {};

  for (const [name, value] of Object.entries(properties ?? {})) {
    const property = asRecord(value);
    const type = typeof property?.type === "string" ? property.type : "string";
    inputs[name] = {
      type,
      required: required.has(name),
      description: typeof property?.description === "string" ? property.description : undefined,
      default: property?.default,
    };
  }

  return inputs;
}

function skillSourceToRaw(source: SkillSource): Record<string, unknown> {
  const raw: Record<string, unknown> = { type: source.type };
  if (source.command) raw.command = source.command;
  if (source.args.length > 0) raw.args = source.args;
  if (source.cwd) raw.cwd = source.cwd;
  if (source.timeoutSeconds !== undefined) raw.timeout_seconds = source.timeoutSeconds;
  if (source.inputMode) raw.input_mode = source.inputMode;
  if (source.server) {
    raw.server = {
      command: source.server.command,
      args: source.server.args,
      ...(source.server.cwd ? { cwd: source.server.cwd } : {}),
    };
  }
  if (source.catalogRef) raw.catalog_ref = source.catalogRef;
  if (source.tool) raw.tool = source.tool;
  if (source.arguments) raw.arguments = source.arguments;
  if (source.agentCardUrl) raw.agent_card_url = source.agentCardUrl;
  if (source.agentIdentity) raw.agent_identity = source.agentIdentity;
  if (source.agent) raw.agent = source.agent;
  if (source.task) raw.task = source.task;
  if (source.outputs) raw.outputs = source.outputs;
  return raw;
}

function normalizeCatalogRef(ref: string): string {
  return ref.trim().toLowerCase();
}

