import {
  createImportedTool,
  type ToolCatalogAdapter,
  type ToolCatalogResolvedTool,
  type ToolCatalogSearchResult,
} from "@runxhq/runtime-local/tool-catalogs";
import { createRunxSdk, type RunSkillOptions, type RunxSdk, type RunxSdkOptions } from "@runxhq/runtime-local/sdk";
import type { RunLocalSkillResult } from "@runxhq/runtime-local";
import { errorMessage, isRecord } from "@runxhq/core/util";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { zodToJsonSchema } from "zod-to-json-schema";

export const langchainPackage = "@runxhq/langchain";

export interface LangChainToolLike {
  readonly name: string;
  readonly description: string;
  readonly schema?: unknown;
  readonly invoke: StructuredToolInterface["invoke"];
}

export interface LangChainToolCatalogAdapterOptions {
  readonly source: string;
  readonly label: string;
  readonly namespace: string;
  readonly baseDirectory: string;
  readonly tools:
    | readonly LangChainToolLike[]
    | { readonly getTools: () => readonly LangChainToolLike[] }
    | (() => Promise<readonly LangChainToolLike[]> | readonly LangChainToolLike[]);
  readonly tags?: readonly string[];
}

export interface RunxLangChainSdkLike {
  readonly runSkill: (options: RunSkillOptions) => Promise<RunLocalSkillResult>;
}

export interface RunxLangChainToolOptions {
  readonly name: string;
  readonly description: string;
  readonly schema: object;
  readonly skillPath: string;
  readonly sdk?: RunxLangChainSdkLike;
  readonly sdkOptions?: RunxSdkOptions;
  readonly runOptions?: Omit<RunSkillOptions, "skillPath" | "inputs">;
  readonly mapInput?: (input: unknown) => Readonly<Record<string, unknown>>;
  readonly formatOutput?: (result: RunLocalSkillResult) => unknown;
}

export function createLangChainToolCatalogAdapter(
  options: LangChainToolCatalogAdapterOptions,
): ToolCatalogAdapter {
  let cachedToolsPromise: Promise<readonly ImportedLangChainTool[]> | undefined;

  async function loadImportedTools(): Promise<readonly ImportedLangChainTool[]> {
    if (!cachedToolsPromise) {
      cachedToolsPromise = loadLangChainTools(options);
    }
    return await cachedToolsPromise;
  }

  return {
    source: options.source,
    label: options.label,
    search: async (query, searchOptions = {}) => {
      const normalizedQuery = query.trim().toLowerCase();
      const tools = await loadImportedTools();
      return tools
        .map((entry) => entry.result)
        .filter((result) => normalizedQuery.length === 0 || searchableText(result).includes(normalizedQuery))
        .slice(0, searchOptions.limit ?? 20);
    },
    resolve: async (ref) => {
      const tools = await loadImportedTools();
      const normalizedRef = ref.trim().toLowerCase();
      return tools.find((entry) => matchesImportedTool(entry, normalizedRef));
    },
  };
}

export function createRunxLangChainTool(
  options: RunxLangChainToolOptions,
): StructuredToolInterface {
  const sdk = options.sdk ?? createRunxSdk(options.sdkOptions);
  return tool(
    async (input) => {
      const result = await sdk.runSkill({
        ...(options.runOptions ?? {}),
        skillPath: options.skillPath,
        inputs: options.mapInput ? options.mapInput(input) : toInputRecord(input),
      });

      if (result.status === "needs_resolution") {
        throw new Error(
          `runx workflow '${options.name}' paused for resolution; LangChain tools must be fully specified before invocation.`,
        );
      }
      if (result.status === "policy_denied") {
        throw new Error(
          `runx workflow '${options.name}' was denied by policy${result.reasons.length > 0 ? `: ${result.reasons.join("; ")}` : "."}`,
        );
      }
      if (result.status === "failure") {
        throw new Error(
          result.execution.errorMessage
            ?? result.execution.stderr
            ?? result.execution.stdout
            ?? `runx workflow '${options.name}' failed.`,
        );
      }

      const formatted = options.formatOutput?.(result);
      return typeof formatted === "string" ? formatted : formatted ?? result.execution.stdout;
    },
    {
      name: options.name,
      description: options.description,
      schema: options.schema as never,
    },
  );
}

interface ImportedLangChainTool extends ToolCatalogResolvedTool {
  readonly externalName: string;
}

async function loadLangChainTools(
  options: LangChainToolCatalogAdapterOptions,
): Promise<readonly ImportedLangChainTool[]> {
  const tools = await resolveTools(options.tools);
  return tools.map((langChainTool) => importedToolFromLangChain(options, langChainTool));
}

async function resolveTools(
  tools:
    | readonly LangChainToolLike[]
    | { readonly getTools: () => readonly LangChainToolLike[] }
    | (() => Promise<readonly LangChainToolLike[]> | readonly LangChainToolLike[]),
): Promise<readonly LangChainToolLike[]> {
  if (typeof tools === "function") {
    return await tools();
  }
  if (hasGetTools(tools)) {
    return tools.getTools();
  }
  return tools;
}

function importedToolFromLangChain(
  options: LangChainToolCatalogAdapterOptions,
  langChainTool: LangChainToolLike,
): ImportedLangChainTool {
  const imported = createImportedTool({
    name: langChainTool.name,
    description: langChainTool.description,
    namespace: options.namespace,
    externalName: langChainTool.name,
    source: options.source,
    sourceLabel: options.label,
    sourceType: "langchain",
    inputSchema: normalizeLangChainSchema(langChainTool.schema),
    tags: options.tags ?? ["langchain"],
  });

  return {
    ...imported,
    externalName: langChainTool.name,
    skillDirectory: options.baseDirectory,
    referencePath: `catalog:${options.source}:${imported.result.name}`,
    invoke: async (request) => {
      try {
        const result = await langChainTool.invoke(request.inputs, request.signal ? { signal: request.signal } : undefined);
        return {
          status: "success",
          stdout: stringifyLangChainResult(result),
          metadata: {
            langchain: {
              tool: langChainTool.name,
            },
          },
        } as const;
      } catch (error) {
        const message = errorMessage(error);
        return {
          status: "failure",
          stdout: "",
          stderr: message,
          errorMessage: message,
          metadata: {
            langchain: {
              tool: langChainTool.name,
            },
          },
        } as const;
      }
    },
  };
}

function normalizeLangChainSchema(schema: unknown): Readonly<Record<string, unknown>> | undefined {
  if (isRecord(schema) && typeof schema.toJSONSchema === "function") {
    const normalized = schema.toJSONSchema();
    return isRecord(normalized) ? normalized : undefined;
  }
  if (isRecord(schema) && ("_def" in schema || "safeParse" in schema || "parse" in schema)) {
    const normalized = zodToJsonSchema(schema as unknown as Parameters<typeof zodToJsonSchema>[0]);
    return isRecord(normalized) ? normalized : undefined;
  }
  if (isRecord(schema) && typeof schema.type === "string") {
    return schema;
  }
  return undefined;
}

function matchesImportedTool(entry: ImportedLangChainTool, ref: string): boolean {
  return [
    entry.result.name,
    entry.result.tool_id,
    entry.result.catalog_ref,
    `${entry.result.source}:${entry.result.name}`,
    `${entry.result.namespace}.${entry.externalName}`,
    entry.externalName,
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

function stringifyLangChainResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (Array.isArray(result)) {
    return result.map((entry) => stringifyLangChainResult(entry)).join("\n");
  }
  if (isRecord(result) && typeof result.content === "string") {
    return result.content;
  }
  if (isRecord(result) && Array.isArray(result.content)) {
    return result.content
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry) ?? ""))
      .join("\n");
  }
  return JSON.stringify(result) ?? "";
}

function toInputRecord(input: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(input)) {
    return input;
  }
  if (typeof input === "string") {
    return { input };
  }
  return { value: input };
}

function hasGetTools(
  value: readonly LangChainToolLike[] | { readonly getTools: () => readonly LangChainToolLike[] },
): value is { readonly getTools: () => readonly LangChainToolLike[] } {
  return "getTools" in value && typeof value.getTools === "function";
}

export type { RunxSdk, RunxSdkOptions };
