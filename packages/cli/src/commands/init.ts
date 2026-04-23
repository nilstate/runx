import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  resolveRunxGlobalHomeDir,
  resolveRunxOfficialSkillsDir,
  resolveRunxProjectDir,
} from "@runxhq/core/config";

import { ensureRunxInstallState, ensureRunxProjectState } from "../runx-state.js";

export interface InitCommandArgs {
  readonly initAction?: "project" | "global";
  readonly prefetchOfficial?: boolean;
}

export interface InitResult {
  readonly action: "project" | "global";
  readonly created: boolean;
  readonly project_dir?: string;
  readonly project_id?: string;
  readonly global_home_dir?: string;
  readonly installation_id?: string;
  readonly official_cache_dir?: string;
}

export async function handleInitCommand(parsed: InitCommandArgs, env: NodeJS.ProcessEnv): Promise<InitResult> {
  if (!parsed.initAction) {
    throw new Error("Invalid init invocation.");
  }
  if (parsed.initAction === "global") {
    const globalHomeDir = resolveRunxGlobalHomeDir(env);
    const install = await ensureRunxInstallState(globalHomeDir);
    const officialCacheDir = resolveRunxOfficialSkillsDir(env);
    if (parsed.prefetchOfficial) {
      await mkdir(officialCacheDir, { recursive: true });
    }
    return {
      action: "global",
      created: install.created,
      global_home_dir: globalHomeDir,
      installation_id: install.state.installation_id,
      official_cache_dir: parsed.prefetchOfficial ? officialCacheDir : undefined,
    };
  }

  const projectDir = resolveRunxProjectDir(env);
  const project = await ensureRunxProjectState(projectDir);
  await mkdir(path.join(projectDir, "skills"), { recursive: true });
  await mkdir(path.join(projectDir, "tools"), { recursive: true });
  return {
    action: "project",
    created: project.created,
    project_dir: projectDir,
    project_id: project.state.project_id,
  };
}
