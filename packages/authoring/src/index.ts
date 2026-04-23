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

export interface ToolDefinition<
  Inputs extends Record<string, InputParser<unknown>> = Record<string, InputParser<unknown>>,
  Output = unknown,
> {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly schema?: string;
  readonly inputs?: Inputs;
  readonly output?: {
    readonly packet?: string;
    readonly wrap_as?: string;
  };
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

export function artifact<T = unknown>(options: { readonly optional?: boolean } = {}): InputParser<T | undefined> {
  return {
    optional: options.optional === true,
    manifest: { type: "json", required: options.optional !== true, artifact: true },
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

export function optionalArtifact<T = unknown>(): InputParser<T | undefined> {
  return artifact<T>({ optional: true });
}

export function stringInput(options: { readonly optional?: boolean; readonly default?: string } = {}): InputParser<string | undefined> {
  return {
    optional: options.optional === true || options.default !== undefined,
    manifest: {
      type: "string",
      required: options.optional !== true && options.default === undefined,
      ...(options.default !== undefined ? { default: options.default } : {}),
    },
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

export function numberInput(options: { readonly optional?: boolean; readonly default?: number } = {}): InputParser<number | undefined> {
  return {
    optional: options.optional === true || options.default !== undefined,
    manifest: {
      type: "number",
      required: options.optional !== true && options.default === undefined,
      ...(options.default !== undefined ? { default: options.default } : {}),
    },
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

export function booleanInput(options: { readonly optional?: boolean; readonly default?: boolean } = {}): InputParser<boolean | undefined> {
  return {
    optional: options.optional === true || options.default !== undefined,
    manifest: {
      type: "boolean",
      required: options.optional !== true && options.default === undefined,
      ...(options.default !== undefined ? { default: options.default } : {}),
    },
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

export function jsonInput<T = unknown>(options: { readonly optional?: boolean; readonly default?: T } = {}): InputParser<T | undefined> {
  return {
    optional: options.optional === true || options.default !== undefined,
    manifest: {
      type: "json",
      required: options.optional !== true && options.default === undefined,
      ...(options.default !== undefined ? { default: options.default } : {}),
    },
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
  options: { readonly optional?: boolean; readonly default?: Readonly<Record<string, unknown>> } = {},
): InputParser<Readonly<Record<string, unknown>> | undefined> {
  return {
    optional: options.optional === true || options.default !== undefined,
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

export function arrayInput<T = unknown>(options: { readonly optional?: boolean; readonly default?: readonly T[] } = {}): InputParser<readonly T[] | undefined> {
  return {
    optional: options.optional === true || options.default !== undefined,
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

export function rawInput<T = unknown>(options: { readonly optional?: boolean } = {}): InputParser<T | undefined> {
  return {
    optional: options.optional === true,
    manifest: { type: "json", required: options.optional !== true },
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

function finalizeOutput<Output>(
  output: Output | ToolFailure,
  definition: Pick<ToolDefinition<Record<string, InputParser<unknown>>, Output>, "schema" | "output">,
): Output | ToolFailure {
  if (isToolFailure(output)) {
    return output;
  }
  const pruned = pruneUndefined(output);
  const schema = definition.schema ?? definition.output?.packet;
  if (!schema || !isRecord(pruned) || "schema" in pruned) {
    return pruned;
  }
  return {
    schema,
    data: pruned,
  } as Output;
}

function isToolFailure(value: unknown): value is ToolFailure {
  return typeof value === "object" && value !== null && (value as ToolFailure)[failureMarker] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
