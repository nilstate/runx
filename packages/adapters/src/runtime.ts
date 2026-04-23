import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SkillAdapter } from "@runxhq/core/executor";

import { createDefaultSkillAdapters } from "./index.js";

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

export async function createDefaultLocalSkillRuntime(
  options: DefaultLocalSkillRuntimeOptions = {},
): Promise<DefaultLocalSkillRuntime> {
  const paths = await resolveLocalSkillRuntimePaths(options);
  return {
    adapters: options.adapters ?? createDefaultSkillAdapters(),
    env: createDefaultLocalSkillEnv(options.env),
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
