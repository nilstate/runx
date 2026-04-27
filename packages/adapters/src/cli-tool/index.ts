export const cliToolAdapterPackage = "@runxhq/adapters/cli-tool";

import { mkdtempSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { cleanupLocalProcessSandbox, prepareLocalProcessSandbox } from "@runxhq/runtime-local";

export type CliToolInputMode = "args" | "stdin" | "none";

export interface CliToolSource {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutSeconds?: number;
  readonly inputMode?: CliToolInputMode;
  readonly sandbox?: CliToolSandbox;
}

export interface CliToolSandbox {
  readonly profile: "readonly" | "workspace-write" | "network" | "unrestricted-local-dev";
  readonly cwdPolicy?: "skill-directory" | "workspace" | "custom";
  readonly envAllowlist?: readonly string[];
  readonly network?: boolean;
  readonly writablePaths?: readonly string[];
  readonly requireEnforcement?: boolean;
  readonly approvedEscalation?: boolean;
}

export interface CliToolInvokeRequest {
  readonly source: CliToolSource;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly resolvedInputs?: Readonly<Record<string, string>>;
  readonly skillDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export interface CliToolInvokeResult {
  readonly status: "success" | "failure";
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly errorMessage?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CliToolAdapter {
  readonly type: "cli-tool";
  readonly invoke: (request: CliToolInvokeRequest) => Promise<CliToolInvokeResult>;
}

const outputLimitBytes = 1024 * 1024;
const forceKillGraceMs = 100;
const maxInlineInputsBytes = 48 * 1024;
const maxInlineInputValueBytes = 8 * 1024;

export function createCliToolAdapter(): CliToolAdapter {
  return {
    type: "cli-tool",
    invoke: invokeCliTool,
  };
}

export async function invokeCliTool(request: CliToolInvokeRequest): Promise<CliToolInvokeResult> {
  if (!request.source.command) {
    return {
      status: "failure",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      durationMs: 0,
      errorMessage: "cli-tool source is missing command",
    };
  }

  const started = performance.now();
  const resolved = request.resolvedInputs ?? {};
  const args = (request.source.args ?? []).map((arg) => resolveArg(arg, resolved, request.inputs));
  const writablePaths = (request.source.sandbox?.writablePaths ?? []).map((writablePath) =>
    resolveArg(writablePath, resolved, request.inputs));
  const sandbox = prepareLocalProcessSandbox({
    sandbox: request.source.sandbox,
    skillDirectory: request.skillDirectory,
    sourceCwd: request.source.cwd,
    env: request.env,
    writablePaths,
    command: request.source.command,
    args,
  });
  if (sandbox.status === "deny") {
    return {
      status: "failure",
      stdout: "",
      stderr: sandbox.reason,
      exitCode: null,
      signal: null,
      durationMs: Math.round(performance.now() - started),
      errorMessage: sandbox.reason,
      metadata: {
        sandbox: sandbox.metadata,
      },
    };
  }
  const cwd = sandbox.cwd;
  const childEnv = buildChildEnv(sandbox.env, request.inputs);
  const command = sandbox.command ?? request.source.command;
  const spawnArgs = sandbox.args ?? args;

  return await new Promise<CliToolInvokeResult>((resolve) => {
    const child = spawn(command as string, spawnArgs, {
      cwd,
      env: childEnv,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let spawnError: Error | undefined;
    let timedOut = false;
    let aborted = false;
    let finished = false;

    let forceKill: NodeJS.Timeout | undefined;
    const timeoutMs = Math.max(0.05, request.source.timeoutSeconds ?? 60) * 1000;
    const timeout = setTimeout(() => {
      timedOut = true;
      signalChildProcessTree(child.pid, "SIGTERM", child);
      forceKill = setTimeout(() => {
        signalChildProcessTree(child.pid, "SIGKILL", child);
      }, forceKillGraceMs);
    }, timeoutMs);

    // Cooperative cancellation via AbortSignal
    const abortListener = () => {
      aborted = true;
      signalChildProcessTree(child.pid, "SIGTERM", child);
      forceKill = setTimeout(() => signalChildProcessTree(child.pid, "SIGKILL", child), forceKillGraceMs);
    };
    if (request.signal) {
      if (request.signal.aborted) {
        abortListener();
      } else {
        request.signal.addEventListener("abort", abortListener, { once: true });
      }
    }

	    child.stdout.on("data", (chunk: Buffer) => {
	      const remaining = outputLimitBytes - stdoutBytes;
	      if (remaining <= 0) return;
	      const captured = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
	      stdoutChunks.push(captured);
	      stdoutBytes += captured.length;
	    });

	    child.stderr.on("data", (chunk: Buffer) => {
	      const remaining = outputLimitBytes - stderrBytes;
	      if (remaining <= 0) return;
	      const captured = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
	      stderrChunks.push(captured);
	      stderrBytes += captured.length;
	    });

    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", (exitCode, exitSignal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      request.signal?.removeEventListener("abort", abortListener);
      cleanupLocalProcessSandbox(sandbox);

      const durationMs = Math.round(performance.now() - started);
      const errorMessage = spawnError?.message
        ?? (aborted ? "cli-tool aborted" : undefined)
        ?? (timedOut ? `cli-tool timed out after ${timeoutMs}ms` : undefined);
      const status = exitCode === 0 && !timedOut && !aborted && !spawnError ? "success" : "failure";

      const stdout = truncateToBytes(Buffer.concat(stdoutChunks), outputLimitBytes);
      const stderr = truncateToBytes(Buffer.concat(stderrChunks), outputLimitBytes);

      resolve({
        status,
        stdout,
        stderr,
        exitCode,
        signal: exitSignal,
        durationMs,
        errorMessage,
        metadata: {
          sandbox: sandbox.metadata,
        },
      });
    });

    if (request.source.inputMode === "stdin") {
      child.stdin.end(JSON.stringify(request.inputs));
    } else {
      child.stdin.end();
    }
  });
}

function signalChildProcessTree(pid: number | undefined, signal: NodeJS.Signals, child: ReturnType<typeof spawn>): void {
  if (process.platform !== "win32" && pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child below. The process may have exited
      // between scheduling the signal and sending it.
    }
  }
  child.kill(signal);
}

function buildChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  inputs: Readonly<Record<string, unknown>>,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    RUNX_CWD: baseEnv.RUNX_CWD ?? baseEnv.INIT_CWD ?? process.cwd(),
    ...inputEnv(inputs, baseEnv.TMPDIR),
  };
}

function resolveArg(
  template: string,
  resolved: Readonly<Record<string, string>>,
  rawInputs: Readonly<Record<string, unknown>>,
): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    if (key in resolved) return resolved[key];
    return stringifyInput(rawInputs[key]);
  });
}

function inputEnv(inputs: Readonly<Record<string, unknown>>, tempRoot?: string): Record<string, string> {
  const env: Record<string, string> = {};
  const serializedInputs = JSON.stringify(inputs);
  if (Buffer.byteLength(serializedInputs, "utf8") > maxInlineInputsBytes) {
    const tempDir = mkdtempSync(path.join(tempRoot ?? os.tmpdir(), "runx-cli-inputs-"));
    const inputsPath = path.join(tempDir, "inputs.json");
    writeFileSync(inputsPath, serializedInputs, "utf8");
    env.RUNX_INPUTS_PATH = inputsPath;
  } else {
    env.RUNX_INPUTS_JSON = serializedInputs;
  }

  for (const [key, value] of Object.entries(inputs)) {
    const serializedValue = stringifyInput(value);
    if (Buffer.byteLength(serializedValue, "utf8") > maxInlineInputValueBytes) {
      continue;
    }
    env[`RUNX_INPUT_${toEnvName(key)}`] = serializedValue;
  }

  return env;
}

function toEnvName(key: string): string {
  return key.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

function stringifyInput(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function truncateToBytes(buf: Buffer, limit: number): string {
  if (buf.length < limit) return buf.toString("utf8");

  let text = buf.subarray(0, limit).toString("utf8");
  while (text.length > 0 && (text.endsWith("\uFFFD") || Buffer.byteLength(text, "utf8") > limit)) {
    text = text.slice(0, -1);
  }
  return text;
}
