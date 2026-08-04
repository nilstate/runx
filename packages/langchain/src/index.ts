import { spawn } from "node:child_process";

import { tool, type StructuredToolInterface } from "@langchain/core/tools";

export const langchainPackage = "@runxhq/langchain";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

export type RunxSkillCliResult =
  | {
      readonly status: "needs_agent";
      readonly schema?: string;
      readonly run_id?: string;
      readonly requests?: readonly JsonValue[];
      readonly [key: string]: JsonValue | undefined;
    }
  | {
      readonly status: "policy_denied";
      readonly schema?: string;
      readonly reasons?: readonly string[];
      readonly [key: string]: JsonValue | readonly string[] | undefined;
    }
  | {
      readonly status: "failure";
      readonly schema?: string;
      readonly error?: JsonValue;
      readonly [key: string]: JsonValue | undefined;
    }
  | {
      readonly status: "sealed";
      readonly schema?: string;
      readonly skill_name?: string;
      readonly run_id?: string;
      readonly receipt_id?: string;
      readonly result?: JsonValue;
      readonly trace?: JsonValue;
      readonly error?: JsonValue;
      readonly [key: string]: JsonValue | undefined;
    };

export interface RunxCliBoundaryOptions {
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly processRunner?: RunxCliProcessRunner;
}

export type RunxCliProcessRunner = (
  command: string,
  args: readonly string[],
  options: RunxCliProcessOptions,
) => Promise<RunxCliProcessResult>;

export interface RunxSkillCliRunOptions extends RunxCliBoundaryOptions {
  readonly skillPath: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly answersPath?: string;
  readonly receiptDir?: string;
  readonly runId?: string;
}

export interface RunxCliSkillRunner {
  readonly runSkill: (options: RunxSkillCliRunOptions) => Promise<RunxSkillCliResult>;
}

export interface RunxLangChainToolOptions {
  readonly name: string;
  readonly description: string;
  readonly schema: object;
  readonly skillPath: string;
  readonly cli?: RunxCliSkillRunner;
  readonly cliOptions?: RunxCliBoundaryOptions;
  readonly runOptions?: Omit<RunxSkillCliRunOptions, "skillPath" | "inputs">;
  readonly mapInput?: (input: unknown) => Readonly<Record<string, unknown>>;
  readonly formatOutput?: (result: RunxSkillCliResult) => unknown;
}

export function createRunxCliSkillRunner(options: RunxCliBoundaryOptions = {}): RunxCliSkillRunner {
  return {
    runSkill: async (runOptions) => await runSkillWithRunxCli({ ...options, ...runOptions }),
  };
}

export async function runSkillWithRunxCli(options: RunxSkillCliRunOptions): Promise<RunxSkillCliResult> {
  const env = options.env ?? process.env;
  const command = options.command ?? env.RUNX_BIN ?? "runx";
  const args = runxSkillArgs(options);
  const processRunner = options.processRunner ?? spawnRunx;
  const result = await processRunner(command, args, {
    cwd: options.cwd,
    env,
    signal: options.signal,
  });

  if (result.signal) {
    throw new Error(`runx skill was terminated by signal ${result.signal}.`);
  }

  const parsed = parseRunxSkillJson(result.stdout, result.stderr, result.exitCode);
  if (result.exitCode !== 0 && parsed.status === "sealed") {
    throw new Error(
      runxExitMessage(result.exitCode, result.stderr, `runx skill exited with code ${result.exitCode ?? 1}.`),
    );
  }
  return parsed;
}

export function createRunxLangChainTool(
  options: RunxLangChainToolOptions,
): StructuredToolInterface {
  const cli = options.cli ?? createRunxCliSkillRunner(options.cliOptions);
  return tool(
    async (input) => {
      const result = await cli.runSkill({
        ...(options.runOptions ?? {}),
        skillPath: options.skillPath,
        inputs: options.mapInput ? options.mapInput(input) : toInputRecord(input),
      });

      if (result.status === "needs_agent") {
        throw new Error(
          `runx workflow '${options.name}' needs agent input; LangChain tools must be fully specified before invocation.`,
        );
      }
      if (result.status === "policy_denied") {
        const reasons = Array.isArray(result.reasons)
          ? result.reasons.filter((reason) => typeof reason === "string")
          : [];
        throw new Error(
          `runx workflow '${options.name}' was denied by policy${reasons.length > 0 ? `: ${reasons.join("; ")}` : "."}`,
        );
      }
      if (result.status === "failure") {
        throw new Error(skillFailureMessage(options.name, result));
      }

      const formatted = options.formatOutput?.(result);
      return formatted ?? stringifyJson(result.result ?? result);
    },
    {
      name: options.name,
      description: options.description,
      schema: options.schema as never,
    },
  );
}

function runxSkillArgs(options: RunxSkillCliRunOptions): readonly string[] {
  if (options.runId || options.answersPath) {
    if (!options.runId || !options.answersPath) {
      throw new Error("runx resume requires both runId and answersPath.");
    }
    if (Object.keys(options.inputs ?? {}).length > 0) {
      throw new Error("runx resume reads answers from the answers file; pass fresh inputs only on a new skill run.");
    }
    const args = ["resume", options.runId, options.answersPath, "--json"];
    if (options.receiptDir) {
      args.push("--receipt-dir", options.receiptDir);
    }
    return args;
  }
  const args = ["skill", options.skillPath, "--json"];
  if (options.receiptDir) {
    args.push("--receipt-dir", options.receiptDir);
  }
  for (const [name, value] of Object.entries(options.inputs ?? {})) {
    args.push(inputFlag(name), cliInputValue(value));
  }
  return args;
}

function inputFlag(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`runx skill input names must contain only letters, numbers, underscores, or hyphens: ${name}`);
  }
  return `--${name.replaceAll("_", "-")}`;
}

function cliInputValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? "null";
}

export interface RunxCliProcessOptions {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export interface RunxCliProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnRunx(command: string, args: readonly string[], options: RunxCliProcessOptions): Promise<RunxCliProcessResult> {
  return new Promise<RunxCliProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`failed to spawn runx CLI '${command}': ${error.message}`));
    });
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

function parseRunxSkillJson(stdout: string, stderr: string, exitCode: number | null): RunxSkillCliResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(runxExitMessage(exitCode, stderr, "runx skill did not return JSON on stdout."));
  }

  if (!isRecord(parsed)) {
    throw new Error("runx skill JSON output must be an object.");
  }
  if (!isRunxSkillStatus(parsed.status)) {
    throw new Error(`runx skill returned unsupported status '${String(parsed.status)}'.`);
  }
  return parsed as unknown as RunxSkillCliResult;
}

function isRunxSkillStatus(value: unknown): value is RunxSkillCliResult["status"] {
  return value === "needs_agent" || value === "policy_denied" || value === "failure" || value === "sealed";
}

function runxExitMessage(exitCode: number | null, stderr: string, fallback: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length > 0) {
    return `${fallback} ${trimmed}`;
  }
  if (exitCode !== null && exitCode !== 0) {
    return `${fallback} Exit code: ${exitCode}.`;
  }
  return fallback;
}

function skillFailureMessage(name: string, result: Extract<RunxSkillCliResult, { readonly status: "failure" }>): string {
  return stringField(result.error, "message")
    ?? `runx workflow '${name}' failed.`;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function stringifyJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? "";
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
