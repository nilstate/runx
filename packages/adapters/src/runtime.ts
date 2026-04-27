import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ResolutionRequest, ResolutionResponse } from "@runxhq/core/executor";
import type { SkillAdapter } from "@runxhq/core/executor";
import type { Caller, ExecutionEvent } from "@runxhq/runtime-local";

import { executeManagedAgentResolution, loadManagedAgentConfig } from "./agent/index.js";
import { resolveDefaultSkillAdapters } from "./index.js";

export interface LocalSkillRuntimePaths {
  readonly root: string;
  readonly receiptDir: string;
  readonly runxHome: string;
}

export interface DefaultLocalSkillRuntime {
  readonly adapters: readonly SkillAdapter[];
  readonly env: NodeJS.ProcessEnv;
  readonly paths: LocalSkillRuntimePaths;
}

export interface DefaultLocalSkillRuntimeOptions {
  readonly prefix?: string;
  readonly root?: string;
  readonly receiptDir?: string;
  readonly runxHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly adapters?: readonly SkillAdapter[];
}

export interface RuntimeBackedCallerOptions {
  readonly answers?: Readonly<Record<string, unknown>>;
  readonly approvals?: boolean | Readonly<Record<string, boolean>>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onEvent?: (event: ExecutionEvent) => void | Promise<void>;
}

export async function createDefaultLocalSkillRuntime(
  options: DefaultLocalSkillRuntimeOptions = {},
): Promise<DefaultLocalSkillRuntime> {
  const paths = await resolveLocalSkillRuntimePaths(options);
  const env = createDefaultLocalSkillEnv(options.env);
  return {
    adapters: options.adapters ?? await resolveDefaultSkillAdapters(env),
    env,
    paths,
  };
}

export function createDefaultLocalSkillEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const cwd = env.RUNX_CWD ?? env.INIT_CWD ?? process.cwd();
  return {
    ...env,
    RUNX_CWD: cwd,
    INIT_CWD: env.INIT_CWD ?? cwd,
  };
}

export function createRuntimeBackedCaller(options: RuntimeBackedCallerOptions = {}): Caller {
  const env = createDefaultLocalSkillEnv(options.env);
  let agentConfigPromise: Promise<Awaited<ReturnType<typeof loadManagedAgentConfig>>> | undefined;

  return {
    resolve: async (request) => {
      const answered = resolveAnsweredRequest(request, options.answers, options.approvals);
      if (answered !== undefined) {
        return answered;
      }
      if (request.kind !== "cognitive_work") {
        return undefined;
      }
      agentConfigPromise ??= loadManagedAgentConfig(env);
      const agentConfig = await agentConfigPromise;
      return agentConfig
        ? await executeManagedAgentResolution(agentConfig, request, { env })
        : undefined;
    },
    report: async (event) => {
      await options.onEvent?.(event);
    },
  };
}

export async function resolveLocalSkillRuntimePaths(
  options: Pick<DefaultLocalSkillRuntimeOptions, "prefix" | "root" | "receiptDir" | "runxHome"> = {},
): Promise<LocalSkillRuntimePaths> {
  const root = options.root ?? await mkdtemp(path.join(os.tmpdir(), options.prefix ?? "runx-local-skill-"));
  return {
    root,
    receiptDir: path.resolve(options.receiptDir ?? path.join(root, "receipts")),
    runxHome: path.resolve(options.runxHome ?? path.join(root, "home")),
  };
}

function resolveAnsweredRequest(
  request: ResolutionRequest,
  answers: Readonly<Record<string, unknown>> | undefined,
  approvals: boolean | Readonly<Record<string, boolean>> | undefined,
): ResolutionResponse | undefined {
  if (request.kind === "input") {
    const payload = Object.fromEntries(
      request.questions
        .filter((question) => answers?.[question.id] !== undefined)
        .map((question) => [question.id, answers?.[question.id]]),
    );
    return Object.keys(payload).length === 0 ? undefined : { actor: "human", payload };
  }

  if (request.kind === "approval") {
    const approved = typeof approvals === "boolean" ? approvals : approvals?.[request.gate.id];
    return approved === undefined ? undefined : { actor: "human", payload: approved };
  }

  const payload = answers?.[request.id];
  return payload === undefined ? undefined : { actor: "agent", payload };
}
