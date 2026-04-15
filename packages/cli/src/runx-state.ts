import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RunxProjectState {
  readonly version: 1;
  readonly project_id: string;
  readonly created_at: string;
}

export interface RunxInstallState {
  readonly version: 1;
  readonly installation_id: string;
  readonly created_at: string;
}

export async function readRunxProjectState(projectDir: string): Promise<RunxProjectState | undefined> {
  return await readJsonFile<RunxProjectState>(path.join(projectDir, "project.json"));
}

export async function ensureRunxProjectState(
  projectDir: string,
  now: () => string = () => new Date().toISOString(),
): Promise<{ readonly state: RunxProjectState; readonly created: boolean }> {
  const existing = await readRunxProjectState(projectDir);
  if (existing) {
    return {
      state: existing,
      created: false,
    };
  }
  const state: RunxProjectState = {
    version: 1,
    project_id: `proj_${randomUUID()}`,
    created_at: now(),
  };
  await mkdir(projectDir, { recursive: true });
  await writeJsonFile(path.join(projectDir, "project.json"), state);
  return {
    state,
    created: true,
  };
}

export async function readRunxInstallState(globalHomeDir: string): Promise<RunxInstallState | undefined> {
  return await readJsonFile<RunxInstallState>(path.join(globalHomeDir, "install.json"));
}

export async function ensureRunxInstallState(
  globalHomeDir: string,
  now: () => string = () => new Date().toISOString(),
): Promise<{ readonly state: RunxInstallState; readonly created: boolean }> {
  const existing = await readRunxInstallState(globalHomeDir);
  if (existing) {
    return {
      state: existing,
      created: false,
    };
  }
  const state: RunxInstallState = {
    version: 1,
    installation_id: `inst_${randomUUID()}`,
    created_at: now(),
  };
  await mkdir(globalHomeDir, { recursive: true });
  await writeJsonFile(path.join(globalHomeDir, "install.json"), state);
  return {
    state,
    created: true,
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
