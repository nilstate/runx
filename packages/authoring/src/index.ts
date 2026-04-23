import path from "node:path";

export { Type as t, type Static, type TSchema } from "@sinclair/typebox";
import type { Static, TSchema } from "@sinclair/typebox";

export const authoringPackage = "@runxhq/authoring";

const failureMarker = Symbol("runx.tool.failure");

export interface PacketDefinition<Schema extends TSchema = TSchema> {
  readonly id: string;
  readonly schema: Schema;
}

export function definePacket<const Schema extends TSchema>(
  definition: PacketDefinition<Schema>,
): PacketDefinition<Schema> & { readonly type?: Static<Schema> } {
  return definition as PacketDefinition<Schema> & { readonly type?: Static<Schema> };
}

export interface InputParser<T> {
  readonly optional?: boolean;
  readonly manifest?: Readonly<Record<string, unknown>>;
  parse(value: unknown, label: string): T;
}

export interface ToolFailure {
  readonly output: unknown;
  readonly exitCode: number;
  readonly stderr?: string;
  readonly [failureMarker]: true;
}

export interface ToolOutputDefinition extends Readonly<Record<string, unknown>> {
  readonly packet?: string;
  readonly wrap_as?: string;
  readonly named_emits?: Readonly<Record<string, string>>;
  readonly outputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface ToolDefinition<
  Inputs extends Record<string, InputParser<unknown>> = Record<string, InputParser<unknown>>,
  Output = unknown,
> {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly schema?: string;
  readonly inputs?: Inputs;
  readonly output?: ToolOutputDefinition;
  readonly scopes?: readonly string[];
  readonly source?: Readonly<Record<string, unknown>>;
  run(args: {
    readonly inputs: MaterializedInputs<Inputs>;
    readonly rawInputs: Readonly<Record<string, unknown>>;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly repoRoot?: string;
  }): Output | ToolFailure | Promise<Output | ToolFailure>;
}

export type MaterializedInputs<Inputs extends Record<string, InputParser<unknown>>> = {
  readonly [Key in keyof Inputs]: Inputs[Key] extends InputParser<infer Value> ? Value : never;
};

export interface DefinedTool<
  Inputs extends Record<string, InputParser<unknown>> = Record<string, InputParser<unknown>>,
  Output = unknown,
> extends ToolDefinition<Inputs, Output> {
  runWith(rawInputs?: Readonly<Record<string, unknown>>): Promise<Output | ToolFailure>;
  main(): Promise<void>;
}

export function defineTool<
  const Inputs extends Record<string, InputParser<unknown>> = Record<string, InputParser<unknown>>,
  Output = unknown,
>(definition: ToolDefinition<Inputs, Output>): DefinedTool<Inputs, Output> {
  const tool = {
    ...definition,
    async runWith(rawInputs: Readonly<Record<string, unknown>> = {}) {
      const inputs = materializeInputs(definition.inputs ?? ({} as Inputs), rawInputs, definition.name);
      const output = await definition.run({
        inputs,
        rawInputs,
        env: process.env,
        cwd: process.cwd(),
        repoRoot: process.env.RUNX_REPO_ROOT ? path.resolve(process.env.RUNX_REPO_ROOT) : undefined,
      });
      return finalizeOutput(output, definition);
    },
    async main() {
      try {
        const rawInputs = parseInputs(process.env.RUNX_INPUTS_JSON);
        const output = await this.runWith(rawInputs);
        if (isToolFailure(output)) {
          process.stdout.write(JSON.stringify(output.output));
          if (output.stderr) {
            process.stderr.write(output.stderr.endsWith("\n") ? output.stderr : `${output.stderr}\n`);
          }
          process.exitCode = output.exitCode;
          return;
        }
        process.stdout.write(JSON.stringify(output));
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          })}\n`,
        );
        process.exitCode = 1;
      }
    },
  } satisfies DefinedTool<Inputs, Output>;

  return tool;
}

export function failure(output: unknown, options: { readonly exitCode?: number; readonly stderr?: string } = {}): ToolFailure {
  return {
    [failureMarker]: true,
    output,
    exitCode: Number.isInteger(options.exitCode) && Number(options.exitCode) > 0 ? Number(options.exitCode) : 1,
    stderr: typeof options.stderr === "string" ? options.stderr : undefined,
  };
}

interface InputDescriptionOption {
  readonly description?: string;
}

interface OptionalInputOption extends InputDescriptionOption {
  readonly optional?: boolean;
}

interface StringInputOptions extends OptionalInputOption {
  readonly default?: string;
}

interface NumberInputOptions extends OptionalInputOption {
  readonly default?: number;
}

interface BooleanInputOptions extends OptionalInputOption {
  readonly default?: boolean;
}

interface JsonInputOptions<T> extends OptionalInputOption {
  readonly default?: T;
}

function addManifestDescription(
  manifest: Readonly<Record<string, unknown>>,
  description: string | undefined,
): Readonly<Record<string, unknown>> {
  return typeof description === "string" && description.trim().length > 0
    ? { ...manifest, description }
    : manifest;
}

export function artifact<T = unknown>(options: OptionalInputOption = {}): InputParser<T | undefined> {
  return {
    optional: options.optional === true,
    manifest: addManifestDescription(
      { type: "json", required: options.optional !== true, artifact: true },
      options.description,
    ),
    parse(value, label) {
      if (value === undefined || value === null) {
        if (options.optional === true) {
          return undefined;
        }
        throw new Error(`${label} is required.`);
      }
      return unwrapArtifactData(value, label) as T;
    },
  };
}

export function optionalArtifact<T = unknown>(options: InputDescriptionOption = {}): InputParser<T | undefined> {
  return artifact<T>({ ...options, optional: true });
}

export function stringInput(options: StringInputOptions = {}): InputParser<string | undefined> {
  return {
    optional: options.optional === true || options.default !== undefined,
    manifest: addManifestDescription({
      type: "string",
      required: options.optional !== true && options.default === undefined,
      ...(options.default !== undefined ? { default: options.default } : {}),
    }, options.description),
    parse(value, label) {
      const resolved = value ?? options.default;
      if (resolved === undefined || resolved === null || resolved === "") {
        if (options.optional === true || options.default !== undefined) {
          return undefined;
        }
        throw new Error(`${label} is required.`);
      }
      return String(resolved);
    },
  };
}

export function numberInput(options: NumberInputOptions = {}): InputParser<number | undefined> {
  return {
    optional: options.optional === true || options.default !== undefined,
    manifest: addManifestDescription({
      type: "number",
      required: options.optional !== true && options.default === undefined,
      ...(options.default !== undefined ? { default: options.default } : {}),
    }, options.description),
    parse(value, label) {
      const resolved = value ?? options.default;
      if (resolved === undefined || resolved === null || resolved === "") {
        if (options.optional === true || options.default !== undefined) {
          return undefined;
        }
        throw new Error(`${label} is required.`);
      }
      const parsed = typeof resolved === "number" ? resolved : Number(resolved);
      if (!Number.isFinite(parsed)) {
        throw new Error(`${label} must be a finite number.`);
      }
      return parsed;
    },
  };
}

export function booleanInput(options: BooleanInputOptions = {}): InputParser<boolean | undefined> {
  return {
    optional: options.optional === true || options.default !== undefined,
    manifest: addManifestDescription({
      type: "boolean",
      required: options.optional !== true && options.default === undefined,
      ...(options.default !== undefined ? { default: options.default } : {}),
    }, options.description),
    parse(value, label) {
      const resolved = value ?? options.default;
      if (resolved === undefined || resolved === null || resolved === "") {
        if (options.optional === true || options.default !== undefined) {
          return undefined;
        }
        throw new Error(`${label} is required.`);
      }
      if (typeof resolved === "boolean") {
        return resolved;
      }
      if (typeof resolved === "number") {
        if (resolved === 1) return true;
        if (resolved === 0) return false;
      }
      if (typeof resolved === "string") {
        const normalized = resolved.trim().toLowerCase();
        if (["true", "1", "yes"].includes(normalized)) return true;
        if (["false", "0", "no"].includes(normalized)) return false;
      }
      throw new Error(`${label} must be a boolean.`);
    },
  };
}

export function jsonInput<T = unknown>(options: JsonInputOptions<T> = {}): InputParser<T | undefined> {
  return {
    optional: options.optional === true || options.default !== undefined,
    manifest: addManifestDescription({
      type: "json",
      required: options.optional !== true && options.default === undefined,
      ...(options.default !== undefined ? { default: options.default } : {}),
    }, options.description),
    parse(value, label) {
      const resolved = value ?? options.default;
      if (resolved === undefined || resolved === null || resolved === "") {
        if (options.optional === true || options.default !== undefined) {
          return undefined;
        }
        throw new Error(`${label} is required.`);
      }
      if (typeof resolved !== "string") {
        return resolved as T;
      }
      try {
        return JSON.parse(resolved) as T;
      } catch {
        throw new Error(`${label} must be valid JSON.`);
      }
    },
  };
}

export function recordInput(
  options: JsonInputOptions<Readonly<Record<string, unknown>>> = {},
): InputParser<Readonly<Record<string, unknown>> | undefined> {
  return {
    optional: options.optional === true || options.default !== undefined,
    manifest: addManifestDescription({
      type: "json",
      required: options.optional !== true && options.default === undefined,
      ...(options.default !== undefined ? { default: options.default } : {}),
    }, options.description),
    parse(value, label) {
      const parsed = jsonInput<Readonly<Record<string, unknown>>>(options).parse(value, label);
      if (parsed === undefined) {
        return undefined;
      }
      if (!isRecord(parsed)) {
        throw new Error(`${label} must be an object.`);
      }
      return parsed;
    },
  };
}

export function arrayInput<T = unknown>(options: JsonInputOptions<readonly T[]> = {}): InputParser<readonly T[] | undefined> {
  return {
    optional: options.optional === true || options.default !== undefined,
    manifest: addManifestDescription({
      type: "json",
      required: options.optional !== true && options.default === undefined,
      ...(options.default !== undefined ? { default: options.default } : {}),
    }, options.description),
    parse(value, label) {
      const parsed = jsonInput<readonly T[]>(options).parse(value, label);
      if (parsed === undefined) {
        return undefined;
      }
      if (!Array.isArray(parsed)) {
        throw new Error(`${label} must be an array.`);
      }
      return parsed;
    },
  };
}

export function rawInput<T = unknown>(options: OptionalInputOption = {}): InputParser<T | undefined> {
  return {
    optional: options.optional === true,
    manifest: addManifestDescription({ type: "json", required: options.optional !== true }, options.description),
    parse(value, label) {
      if (value === undefined && options.optional !== true) {
        throw new Error(`${label} is required.`);
      }
      return value as T;
    },
  };
}

export function parseInputs(value: string | undefined): Readonly<Record<string, unknown>> {
  if (!value) {
    return {};
  }
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("RUNX_INPUTS_JSON must be a JSON object.");
  }
  return parsed;
}

export function materializeInputs<Inputs extends Record<string, InputParser<unknown>>>(
  schema: Inputs,
  rawInputs: Readonly<Record<string, unknown>>,
  toolName = "tool",
): MaterializedInputs<Inputs> {
  const materialized: Record<string, unknown> = {};
  for (const [key, parser] of Object.entries(schema)) {
    materialized[key] = parser.parse(rawInputs[key], `${toolName} input '${key}'`);
  }
  for (const [key, value] of Object.entries(rawInputs)) {
    if (!(key in schema)) {
      materialized[key] = value;
    }
  }
  return materialized as MaterializedInputs<Inputs>;
}

export function unwrapArtifactData(value: unknown, label: string): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if ("data" in value) {
    return value.data;
  }
  if ("artifact" in value && isRecord(value.artifact) && "data" in value.artifact) {
    return value.artifact.data;
  }
  if ("output" in value && isRecord(value.output) && "data" in value.output) {
    return value.output.data;
  }
  if ("schema" in value || "meta" in value) {
    throw new Error(`${label} is an artifact envelope without data.`);
  }
  return value;
}

export function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => pruneUndefined(entry)) as T;
  }
  if (!isRecord(value)) {
    return value;
  }
  const pruned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      pruned[key] = pruneUndefined(entry);
    }
  }
  return pruned as T;
}

export function prune<T>(value: T): T | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => prune(entry))
      .filter((entry) => entry !== undefined);
    return (items.length > 0 ? items : undefined) as T | undefined;
  }
  if (!isRecord(value)) {
    return value === undefined ? undefined : value;
  }
  const entries = Object.entries(value)
    .map(([key, entry]) => [key, prune(entry)] as const)
    .filter(([, entry]) => entry !== undefined);
  return (entries.length > 0 ? Object.fromEntries(entries) : undefined) as T | undefined;
}

export function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

export function parseJsonObject(
  value: unknown,
  fallback: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function resolveRepoRoot(
  inputs: Readonly<Record<string, unknown>> = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.resolve(
    String(
      inputs.repo_root
        || inputs.project
        || inputs.fixture
        || env.RUNX_CWD
        || process.cwd(),
    ),
  );
}

export function resolveInsideRepo(repoRoot: string, targetPath: string): string {
  const resolvedPath = path.resolve(repoRoot, targetPath);
  if (!resolvedPath.startsWith(`${repoRoot}${path.sep}`) && resolvedPath !== repoRoot) {
    throw new Error(`path escapes repo_root: ${targetPath}`);
  }
  return resolvedPath;
}

function finalizeOutput<Output>(
  output: Output | ToolFailure,
  definition: Pick<ToolDefinition<Record<string, InputParser<unknown>>, Output>, "schema" | "output">,
): Output | ToolFailure {
  if (isToolFailure(output)) {
    return output;
  }
  const pruned = prune(output);
  const schema = definition.schema ?? definition.output?.packet;
  if (!schema || !isRecord(pruned) || "schema" in pruned) {
    return pruned as Output;
  }
  return {
    schema,
    data: pruned,
  } as Output;
}

function isToolFailure(value: unknown): value is ToolFailure {
  return typeof value === "object" && value !== null && (value as ToolFailure)[failureMarker] === true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
