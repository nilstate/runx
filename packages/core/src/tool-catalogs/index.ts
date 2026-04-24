import { createHash } from "node:crypto";

import {
  validateToolManifest,
  type SkillInput,
  type SkillSource,
  type ValidatedTool,
} from "../parser/index.js";
import { createFixtureMcpToolCatalogAdapter } from "./fixture.js";

export const toolCatalogsPackage = "@runxhq/core/tool-catalogs";

export interface ToolCatalogSearchResult {
  readonly tool_id: string;
  readonly name: string;
  readonly summary?: string;
  readonly source: string;
  readonly source_label: string;
  readonly source_type: string;
  readonly namespace: string;
  readonly external_name: string;
  readonly required_scopes: readonly string[];
  readonly tags: readonly string[];
  readonly catalog_ref: string;
}

export interface ToolCatalogSearchOptions {
  readonly limit?: number;
}

export interface ToolInspectProvenance {
  readonly origin: "local" | "imported";
  readonly source?: string;
  readonly source_label?: string;
  readonly source_type?: string;
  readonly namespace?: string;
  readonly external_name?: string;
  readonly catalog_ref?: string;
  readonly tool_id?: string;
  readonly tags?: readonly string[];
}

export interface ToolInspectResult {
  readonly ref: string;
  readonly name: string;
  readonly description?: string;
  readonly execution_source_type: string;
  readonly inputs: Readonly<Record<string, SkillInput>>;
  readonly scopes: readonly string[];
  readonly mutating?: boolean;
  readonly runtime?: unknown;
  readonly risk?: unknown;
  readonly runx?: Record<string, unknown>;
  readonly reference_path: string;
  readonly skill_directory: string;
  readonly provenance: ToolInspectProvenance;
}

export interface ToolCatalogInvokeRequest {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly resolvedInputs?: Readonly<Record<string, string>>;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly skillDirectory: string;
  readonly runId?: string;
  readonly stepId?: string;
}

export type ToolCatalogInvokeResult =
  | {
      readonly status: "success";
      readonly stdout: string;
      readonly stderr?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "failure";
      readonly stdout?: string;
      readonly stderr: string;
      readonly errorMessage?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    };

export interface ToolCatalogResolvedTool {
  readonly tool: ValidatedTool;
  readonly result: ToolCatalogSearchResult;
  readonly skillDirectory: string;
  readonly referencePath: string;
  readonly invoke: (request: ToolCatalogInvokeRequest) => Promise<ToolCatalogInvokeResult>;
}

export interface ToolCatalogAdapter {
  readonly source: string;
  readonly label: string;
  readonly search: (
    query: string,
    options?: ToolCatalogSearchOptions,
  ) => Promise<readonly ToolCatalogSearchResult[]>;
  readonly resolve?: (
    ref: string,
    options?: {
      readonly env?: NodeJS.ProcessEnv;
      readonly searchFromDirectory?: string;
    },
  ) => Promise<ToolCatalogResolvedTool | undefined>;
}

export async function searchToolCatalogAdapters(
  adapters: readonly ToolCatalogAdapter[],
  query: string,
  options: ToolCatalogSearchOptions = {},
): Promise<readonly ToolCatalogSearchResult[]> {
  const results = await Promise.all(adapters.map((adapter) => adapter.search(query, options)));
  return results.flat().slice(0, options.limit ?? 20);
}

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

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export { createMcpToolCatalogAdapter } from "./mcp.js";
export { createFixtureMcpToolCatalogAdapter } from "./fixture.js";
