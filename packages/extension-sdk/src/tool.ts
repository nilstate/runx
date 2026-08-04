import { readFileSync } from "node:fs";
import path from "node:path";

import { errorMessage, isRecord, pruneUndefined } from "./values.js";

const failureMarker = Symbol("runx.tool.failure");

export interface ToolFailure {
  readonly output: unknown;
  readonly exitCode: number;
  readonly stderr?: string;
  readonly [failureMarker]: true;
}

export interface ToolRunContext {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly repoRoot?: string;
}

export interface ToolDefinition<Output = unknown> {
  readonly name: string;
  run(context: ToolRunContext): Output | ToolFailure | Promise<Output | ToolFailure>;
}

export interface DefinedTool<Output = unknown> extends ToolDefinition<Output> {
  runWith(inputs?: Readonly<Record<string, unknown>>): Promise<Output | ToolFailure>;
  main(): Promise<void>;
}

/// Define the process protocol for a manifest-owned local tool. Runx has
/// already materialized, projected, and validated the input map before this
/// helper sees it; this layer only transports that map to domain code.
export function defineTool<Output = unknown>(
  definition: ToolDefinition<Output>,
): DefinedTool<Output> {
  return {
    ...definition,
    async runWith(inputs: Readonly<Record<string, unknown>> = {}) {
      const output = await definition.run({
        inputs,
        env: process.env,
        cwd: process.cwd(),
        repoRoot: process.env.RUNX_REPO_ROOT
          ? path.resolve(process.env.RUNX_REPO_ROOT)
          : undefined,
      });
      return isToolFailure(output) ? output : pruneUndefined(output);
    },
    async main() {
      try {
        const output = await this.runWith(readToolInputs());
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
        process.stderr.write(`${JSON.stringify({ error: { message: errorMessage(error) } })}\n`);
        process.exitCode = 1;
      }
    },
  };
}

export function failure(
  output: unknown,
  options: { readonly exitCode?: number; readonly stderr?: string } = {},
): ToolFailure {
  return {
    [failureMarker]: true,
    output,
    exitCode: Number.isInteger(options.exitCode) && Number(options.exitCode) > 0
      ? Number(options.exitCode)
      : 1,
    stderr: typeof options.stderr === "string" ? options.stderr : undefined,
  };
}

function readToolInputs(): Readonly<Record<string, unknown>> {
  const filePath = process.env.RUNX_INPUTS_PATH;
  const source = filePath
    ? readFileSync(filePath, "utf8")
    : process.env.RUNX_INPUTS_JSON;
  if (!source) return {};
  const parsed = JSON.parse(source) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Runx tool inputs must be a JSON object.");
  }
  return parsed;
}

function isToolFailure(value: unknown): value is ToolFailure {
  return typeof value === "object"
    && value !== null
    && (value as ToolFailure)[failureMarker] === true;
}
