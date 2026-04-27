import { type Caller } from "@runxhq/runtime-local";

import { isPlainRecord } from "../../authoring-utils.js";
import type { DevCommandDependencies } from "../dev.js";
import type { FixtureExecutionRoots } from "./internal.js";

export function resolveFixtureExecutionRoots(
  root: string,
  lane: string,
  workspaceRoot: string | undefined,
): FixtureExecutionRoots | undefined {
  if (lane === "repo-integration") {
    if (!workspaceRoot) {
      return undefined;
    }
    return {
      cwd: workspaceRoot,
      repoRoot: workspaceRoot,
    };
  }
  return {
    cwd: workspaceRoot ?? root,
    repoRoot: root,
  };
}

export function createFixtureCaller(
  fixture: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
  deps: DevCommandDependencies,
): Caller {
  const caller = isPlainRecord(fixture.caller) ? fixture.caller : {};
  const answers = isPlainRecord(caller.answers) ? caller.answers : {};
  const approvals = isPlainRecord(caller.approvals)
    ? Object.fromEntries(Object.entries(caller.approvals).filter(([, value]) => typeof value === "boolean")) as Readonly<Record<string, boolean>>
    : typeof caller.approvals === "boolean"
      ? caller.approvals
      : undefined;
  return deps.createNonInteractiveCaller(answers, approvals, deps.createAgentRuntimeLoader(env));
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
