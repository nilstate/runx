export const cliToolAdapterPackage = "@runx/adapter-cli-tool";

import { spawn } from "node:child_process";
import path from "node:path";

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
  const cwd = resolveCwd(request.skillDirectory, request.source.cwd);
  const resolved = request.resolvedInputs ?? {};
  const args = (request.source.args ?? []).map((arg) => resolveArg(arg, resolved, request.inputs));
  const sandboxMetadata = sandboxExecutionMetadata(request.source.sandbox, cwd);
  const childEnv = buildChildEnv(request.env, request.inputs, request.source.sandbox);

  return await new Promise<CliToolInvokeResult>((resolve) => {
    const child = spawn(request.source.command as string, args, {
      cwd,
      env: childEnv,
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
      child.kill("SIGTERM");
      forceKill = setTimeout(() => {
        child.kill("SIGKILL");
      }, forceKillGraceMs);
    }, timeoutMs);

    // Cooperative cancellation via AbortSignal
    if (request.signal) {
      if (request.signal.aborted) {
        child.kill("SIGTERM");
        aborted = true;
      } else {
        request.signal.addEventListener("abort", () => {
          aborted = true;
          child.kill("SIGTERM");
          forceKill = setTimeout(() => child.kill("SIGKILL"), forceKillGraceMs);
        }, { once: true });
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < outputLimitBytes) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < outputLimitBytes) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", (exitCode, exitSignal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);

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
          sandbox: sandboxMetadata,
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

function buildChildEnv(
  env: NodeJS.ProcessEnv | undefined,
  inputs: Readonly<Record<string, unknown>>,
  sandbox: CliToolSandbox | undefined,
): NodeJS.ProcessEnv {
  const allowlist = sandbox?.envAllowlist;
  const baseEnv =
    allowlist === undefined
      ? { ...env }
      : Object.fromEntries(allowlist.filter((key) => env?.[key] !== undefined).map((key) => [key, env?.[key]]));

  return {
    ...baseEnv,
    RUNX_CWD: baseEnv.RUNX_CWD ?? baseEnv.INIT_CWD ?? process.cwd(),
    ...inputEnv(inputs),
  };
}

function sandboxExecutionMetadata(sandbox: CliToolSandbox | undefined, cwd: string): Readonly<Record<string, unknown>> {
  const profile = sandbox?.profile ?? "readonly";
  const envAllowlist = sandbox?.envAllowlist;
  return {
    profile,
    cwd,
    cwd_policy: sandbox?.cwdPolicy ?? "skill-directory",
    env: envAllowlist ? { mode: "allowlist", allowlist: envAllowlist } : { mode: "ambient-inherited" },
    network: {
      declared: sandbox?.network ?? profile === "network",
      enforcement: "not-enforced-locally",
    },
    writable_paths: sandbox?.writablePaths ?? [],
    filesystem: {
      enforcement: "declared-policy-only",
    },
    approval: {
      required: profile === "unrestricted-local-dev",
      approved: sandbox?.approvedEscalation ?? false,
    },
  };
}

function resolveCwd(skillDirectory: string, sourceCwd: string | undefined): string {
  if (!sourceCwd) {
    return skillDirectory;
  }
  return path.isAbsolute(sourceCwd) ? sourceCwd : path.resolve(skillDirectory, sourceCwd);
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

function inputEnv(inputs: Readonly<Record<string, unknown>>): Record<string, string> {
  const env: Record<string, string> = {
    RUNX_INPUTS_JSON: JSON.stringify(inputs),
  };

  for (const [key, value] of Object.entries(inputs)) {
    env[`RUNX_INPUT_${toEnvName(key)}`] = stringifyInput(value);
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
  if (buf.length <= limit) return buf.toString("utf8");

  const decoder = new TextDecoder("utf8", { fatal: true });
  const minimumEnd = Math.max(0, limit - 3);
  for (let end = limit; end >= minimumEnd; end -= 1) {
    try {
      return decoder.decode(buf.subarray(0, end));
    } catch {
      continue;
    }
  }
  return "";
}
