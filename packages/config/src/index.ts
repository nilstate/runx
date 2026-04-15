import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import os from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RunxConfigFile {
  readonly agent?: {
    readonly provider?: string;
    readonly model?: string;
    readonly api_key_ref?: string;
  };
}

export interface LocalSkillPackage {
  readonly markdown: string;
  readonly xManifest?: string;
}

type RunxConfigKey = "agent.provider" | "agent.model" | "agent.api_key";

interface PathResolutionOptions {
  readonly cwd?: string;
}

interface RegistryPathOptions extends PathResolutionOptions {
  readonly registry?: string;
  readonly registryDir?: string;
}

export function findRunxWorkspaceRoot(start: string): string | undefined {
  let current = start;
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function resolveRunxWorkspaceBase(env: NodeJS.ProcessEnv, options: PathResolutionOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  return env.RUNX_CWD ?? findRunxWorkspaceRoot(cwd) ?? env.INIT_CWD ?? cwd;
}

export function resolvePathFromUserInput(
  userPath: string,
  env: NodeJS.ProcessEnv,
  options: PathResolutionOptions = {},
): string {
  if (path.isAbsolute(userPath)) {
    return userPath;
  }

  const cwd = options.cwd ?? process.cwd();
  for (const base of [env.RUNX_CWD, env.INIT_CWD, findRunxWorkspaceRoot(cwd), cwd]) {
    if (!base) {
      continue;
    }
    const candidate = path.resolve(base, userPath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return path.resolve(resolveRunxWorkspaceBase(env, { cwd }), userPath);
}

export function findNearestProjectRunxDir(start: string): string | undefined {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, ".runx");
    if (existsSync(path.join(candidate, "project.json"))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function resolveRunxProjectDir(env: NodeJS.ProcessEnv, options: PathResolutionOptions = {}): string {
  if (env.RUNX_PROJECT_DIR) {
    return resolvePathFromUserInput(env.RUNX_PROJECT_DIR, env, options);
  }
  const cwd = options.cwd ?? process.cwd();
  return findNearestProjectRunxDir(cwd) ?? path.resolve(resolveRunxWorkspaceBase(env, options), ".runx");
}

export function resolveRunxGlobalHomeDir(env: NodeJS.ProcessEnv, options: PathResolutionOptions = {}): string {
  return env.RUNX_HOME
    ? resolvePathFromUserInput(env.RUNX_HOME, env, options)
    : path.join(os.homedir(), ".runx");
}

export function resolveRunxHomeDir(env: NodeJS.ProcessEnv, options: PathResolutionOptions = {}): string {
  return resolveRunxGlobalHomeDir(env, options);
}

export function resolveRunxMemoryDir(env: NodeJS.ProcessEnv, options: PathResolutionOptions = {}): string {
  return env.RUNX_MEMORY_DIR
    ? resolvePathFromUserInput(env.RUNX_MEMORY_DIR, env, options)
    : path.join(resolveRunxProjectDir(env, options), "memory");
}

export function resolveSkillInstallRoot(env: NodeJS.ProcessEnv, to?: string, options: PathResolutionOptions = {}): string {
  return to ? resolvePathFromUserInput(to, env, options) : path.join(resolveRunxWorkspaceBase(env, options), "skills");
}

export function resolveRunxRegistryPath(env: NodeJS.ProcessEnv, options: RegistryPathOptions = {}): string {
  const { registry, registryDir } = options;
  if (registry && isRemoteRegistryUrl(registry) && !env.RUNX_REGISTRY_DIR && !registryDir) {
    throw new Error("Remote registry transport is not implemented in CE; set RUNX_REGISTRY_DIR for local-backed registry tests.");
  }
  if (registry && !isRemoteRegistryUrl(registry)) {
    return registry.startsWith("file://")
      ? fileURLToPath(registry)
      : resolvePathFromUserInput(registry, env, options);
  }
  if (registryDir) {
    return resolvePathFromUserInput(registryDir, env, options);
  }
  return env.RUNX_REGISTRY_DIR
    ? resolvePathFromUserInput(env.RUNX_REGISTRY_DIR, env, options)
    : path.join(resolveRunxGlobalHomeDir(env, options), "registry");
}

export function resolveRunxOfficialSkillsDir(env: NodeJS.ProcessEnv, options: PathResolutionOptions = {}): string {
  return env.RUNX_OFFICIAL_SKILLS_DIR
    ? resolvePathFromUserInput(env.RUNX_OFFICIAL_SKILLS_DIR, env, options)
    : path.join(resolveRunxGlobalHomeDir(env, options), "official-skills");
}

export function resolveRunxProjectPinsPath(env: NodeJS.ProcessEnv, options: PathResolutionOptions = {}): string {
  return path.join(resolveRunxProjectDir(env, options), "pins.json");
}

export async function loadLocalSkillPackage(skillPath: string): Promise<LocalSkillPackage> {
  const resolvedPath = path.resolve(skillPath);
  const pathStat = await stat(resolvedPath);
  const markdownPath = pathStat.isDirectory() ? path.join(resolvedPath, "SKILL.md") : resolvedPath;
  if (path.basename(markdownPath).toLowerCase() !== "skill.md") {
    throw new Error(
      `Skill packages must be referenced by directory or SKILL.md. Flat markdown files are not supported: ${resolvedPath}`,
    );
  }
  if (!existsSync(markdownPath)) {
    throw new Error(`Skill package '${resolvedPath}' is missing SKILL.md.`);
  }
  const xManifestPath = pathStat.isDirectory()
    ? path.join(resolvedPath, "x.yaml")
    : path.join(path.dirname(resolvedPath), "x.yaml");
  return {
    markdown: await readFile(markdownPath, "utf8"),
    xManifest: await readOptionalFile(xManifestPath),
  };
}

export async function loadRunxConfigFile(configPath: string): Promise<RunxConfigFile> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as RunxConfigFile;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function writeRunxConfigFile(configPath: string, config: RunxConfigFile): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export async function updateRunxConfigValue(
  config: RunxConfigFile,
  key: RunxConfigKey,
  value: string,
  configDir: string,
): Promise<RunxConfigFile> {
  if (key === "agent.provider") {
    return { ...config, agent: { ...config.agent, provider: value } };
  }
  if (key === "agent.model") {
    return { ...config, agent: { ...config.agent, model: value } };
  }
  return {
    ...config,
    agent: {
      ...config.agent,
      api_key_ref: await storeLocalAgentApiKey(configDir, value),
    },
  };
}

export function lookupRunxConfigValue(config: RunxConfigFile, key: RunxConfigKey): unknown {
  if (key === "agent.provider") {
    return config.agent?.provider;
  }
  if (key === "agent.model") {
    return config.agent?.model;
  }
  return config.agent?.api_key_ref ? "[encrypted]" : undefined;
}

export function maskRunxConfigFile(config: RunxConfigFile): RunxConfigFile {
  return config.agent?.api_key_ref
    ? { ...config, agent: { ...config.agent, api_key_ref: "[encrypted]" } }
    : config;
}

export async function loadLocalAgentApiKey(configDir: string, ref: string): Promise<string> {
  const keyPath = path.join(configDir, "keys", `${ref}.json`);
  let payload: {
    readonly alg?: string;
    readonly iv?: string;
    readonly ciphertext?: string;
    readonly auth_tag?: string;
  };

  try {
    payload = JSON.parse(await readFile(keyPath, "utf8")) as typeof payload;
  } catch (error) {
    throw configKeyReadError(keyPath, error);
  }

  if (
    payload.alg !== "aes-256-gcm"
    || typeof payload.iv !== "string"
    || typeof payload.ciphertext !== "string"
    || typeof payload.auth_tag !== "string"
  ) {
    throw configKeyReadError(keyPath);
  }

  try {
    const encryptionKey = createHash("sha256")
      .update(await loadOrCreateLocalConfigSecret(path.join(configDir, "keys")))
      .digest();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      Buffer.from(payload.iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(payload.auth_tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64url")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch (error) {
    throw configKeyReadError(keyPath, error);
  }
}

function isRemoteRegistryUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function configKeyReadError(keyPath: string, cause?: unknown): Error {
  const suffix = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
  return new Error(`runx local agent key corrupted or unreadable at ${keyPath}${suffix}`);
}

async function storeLocalAgentApiKey(configDir: string, apiKey: string): Promise<string> {
  const keyDir = path.join(configDir, "keys");
  await mkdir(keyDir, { recursive: true });
  const encryptionKey = createHash("sha256").update(await loadOrCreateLocalConfigSecret(keyDir)).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ref = `local_agent_key_${createHash("sha256").update(`${iv.toString("hex")}:${Date.now()}`).digest("hex").slice(0, 24)}`;
  await writeFile(
    path.join(keyDir, `${ref}.json`),
    `${JSON.stringify(
      {
        ref,
        alg: "aes-256-gcm",
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        auth_tag: authTag.toString("base64url"),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return ref;
}

async function loadOrCreateLocalConfigSecret(keyDir: string): Promise<string> {
  const keyPath = path.join(keyDir, "local-config-secret");
  try {
    return await readFile(keyPath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    const secret = randomBytes(32).toString("base64url");
    try {
      await writeFile(keyPath, secret, { mode: 0o600, flag: "wx" });
      return secret;
    } catch (writeError) {
      if (isNodeError(writeError) && writeError.code === "EEXIST") {
        return await readFile(keyPath, "utf8");
      }
      throw writeError;
    }
  }
}
