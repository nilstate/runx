import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import os from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { isNodeError, isRecord } from "../util/types.js";
import { readOptionalFile } from "../util/fs.js";
import { fileURLToPath } from "node:url";

import { parseRunnerManifestYaml, parseSkillMarkdown, validateRunnerManifest } from "../parser/index.js";

export interface RunxConfigFile {
  readonly agent?: {
    readonly provider?: string;
    readonly model?: string;
    readonly api_key_ref?: string;
  };
}

export interface RunxWorkspaceConfigFile {
  readonly policy?: {
    readonly strict_cli_tool_inline_code?: boolean;
  };
}

export interface RunxWorkspacePolicy {
  readonly strictCliToolInlineCode: boolean;
}

export interface LocalSkillPackage {
  readonly markdown: string;
  readonly profileDocument?: string;
  readonly profileSourcePath?: string;
}

export interface ResolvedLocalProfile {
  readonly profileDocument?: string;
  readonly profileSourcePath?: string;
  readonly source: "profile-state" | "skill-profile" | "workspace-bindings" | "none";
}

type RunxConfigKey = "agent.provider" | "agent.model" | "agent.api_key";

interface PathResolutionOptions {
  readonly cwd?: string;
  readonly preferExisting?: boolean;
}

interface RegistryPathOptions extends PathResolutionOptions {
  readonly registry?: string;
  readonly registryDir?: string;
}

export type RunxRegistryTarget =
  | {
      readonly mode: "remote";
      readonly registryUrl: string;
    }
  | {
      readonly mode: "local";
      readonly registryPath: string;
      readonly registryUrl?: string;
    };

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
  if (options.preferExisting ?? true) {
    for (const base of [env.RUNX_CWD, env.INIT_CWD, findRunxWorkspaceRoot(cwd), cwd]) {
      if (!base) {
        continue;
      }
      const candidate = path.resolve(base, userPath);
      if (existsSync(candidate)) {
        return candidate;
      }
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
    return resolvePathFromUserInput(env.RUNX_PROJECT_DIR, env, { ...options, preferExisting: false });
  }
  const cwd = options.cwd ?? process.cwd();
  return findNearestProjectRunxDir(cwd) ?? path.resolve(resolveRunxWorkspaceBase(env, options), ".runx");
}

export function resolveRunxWorkspaceConfigPath(env: NodeJS.ProcessEnv, options: PathResolutionOptions = {}): string {
  return path.join(resolveRunxProjectDir(env, options), "config.json");
}

export function resolveRunxGlobalHomeDir(env: NodeJS.ProcessEnv, options: PathResolutionOptions = {}): string {
  return env.RUNX_HOME
    ? resolvePathFromUserInput(env.RUNX_HOME, env, { ...options, preferExisting: false })
    : path.join(os.homedir(), ".runx");
}

export function resolveRunxHomeDir(env: NodeJS.ProcessEnv, options: PathResolutionOptions = {}): string {
  return resolveRunxGlobalHomeDir(env, options);
}

export function resolveRunxKnowledgeDir(env: NodeJS.ProcessEnv, options: PathResolutionOptions = {}): string {
  return env.RUNX_KNOWLEDGE_DIR
    ? resolvePathFromUserInput(env.RUNX_KNOWLEDGE_DIR, env, { ...options, preferExisting: false })
    : path.join(resolveRunxProjectDir(env, options), "knowledge");
}

export function resolveSkillInstallRoot(env: NodeJS.ProcessEnv, to?: string, options: PathResolutionOptions = {}): string {
  return to
    ? resolvePathFromUserInput(to, env, { ...options, preferExisting: false })
    : path.join(resolveRunxWorkspaceBase(env, options), "skills");
}

export function resolveRunxRegistryPath(env: NodeJS.ProcessEnv, options: RegistryPathOptions = {}): string {
  const target = resolveRunxRegistryTarget(env, options);
  return target.mode === "local"
    ? target.registryPath
    : path.join(resolveRunxGlobalHomeDir(env, options), "registry");
}

export function resolveRunxRegistryTarget(env: NodeJS.ProcessEnv, options: RegistryPathOptions = {}): RunxRegistryTarget {
  const { registry, registryDir } = options;
  const configuredRegistry = registry ?? env.RUNX_REGISTRY_URL;
  if (typeof registry === "string") {
    if (isRemoteRegistryUrl(registry)) {
      return {
        mode: "remote",
        registryUrl: registry,
      };
    }
    const localRegistry = registry as string;
    return {
      mode: "local",
      registryPath: localRegistry.startsWith("file://")
        ? fileURLToPath(localRegistry)
        : resolvePathFromUserInput(localRegistry, env, { ...options, preferExisting: false }),
      registryUrl: isRemoteRegistryUrl(env.RUNX_REGISTRY_URL) ? env.RUNX_REGISTRY_URL : undefined,
    };
  }
  if (registryDir) {
    return {
      mode: "local",
      registryPath: resolvePathFromUserInput(registryDir, env, { ...options, preferExisting: false }),
      registryUrl: isRemoteRegistryUrl(configuredRegistry) ? configuredRegistry : undefined,
    };
  }
  if (env.RUNX_REGISTRY_DIR) {
    return {
      mode: "local",
      registryPath: resolvePathFromUserInput(env.RUNX_REGISTRY_DIR, env, { ...options, preferExisting: false }),
      registryUrl: isRemoteRegistryUrl(configuredRegistry) ? configuredRegistry : undefined,
    };
  }
  if (isRemoteRegistryUrl(configuredRegistry)) {
    return {
      mode: "remote",
      registryUrl: configuredRegistry,
    };
  }
  return {
    mode: "local",
    registryPath: path.join(resolveRunxGlobalHomeDir(env, options), "registry"),
    registryUrl: configuredRegistry && !isRemoteRegistryUrl(configuredRegistry) ? configuredRegistry : undefined,
  };
}

export function resolveRunxOfficialSkillsDir(env: NodeJS.ProcessEnv, options: PathResolutionOptions = {}): string {
  return env.RUNX_OFFICIAL_SKILLS_DIR
    ? resolvePathFromUserInput(env.RUNX_OFFICIAL_SKILLS_DIR, env, { ...options, preferExisting: false })
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
  const markdown = await readFile(markdownPath, "utf8");
  const raw = parseSkillMarkdown(markdown);
  const skillName = typeof raw.frontmatter.name === "string" ? raw.frontmatter.name : undefined;
  const binding = skillName
    ? await resolveLocalSkillProfile(markdownPath, skillName)
    : { source: "none" as const };
  return {
    markdown,
    profileDocument: binding.profileDocument,
    profileSourcePath: binding.profileSourcePath,
  };
}

export async function resolveLocalSkillProfile(
  skillPath: string,
  skillName: string,
): Promise<ResolvedLocalProfile> {
  const resolvedPath = path.resolve(skillPath);
  const targetStat = await stat(resolvedPath);
  const skillDirectory = targetStat.isDirectory() ? resolvedPath : path.dirname(resolvedPath);

  const checkedInProfile = await readSkillProfile(skillDirectory, skillName);
  if (checkedInProfile) {
    return {
      profileDocument: checkedInProfile.profileDocument,
      profileSourcePath: checkedInProfile.profileSourcePath,
      source: "skill-profile",
    };
  }

  const profileState = await readProfileState(skillDirectory, skillName);
  if (profileState) {
    return {
      profileDocument: profileState.profileDocument,
      profileSourcePath: profileState.profileSourcePath,
      source: "profile-state",
    };
  }

  for (const bindingRoot of collectBindingRoots(skillDirectory)) {
    const match = await readWorkspaceProfile(skillDirectory, bindingRoot, skillName);
    if (!match) {
      continue;
    }
    return {
      profileDocument: match.profileDocument,
      profileSourcePath: match.profileSourcePath,
      source: "workspace-bindings",
    };
  }

  return {
    source: "none",
  };
}

export async function loadRunxConfigFile(configPath: string): Promise<RunxConfigFile> {
  return await loadOptionalJsonFile<RunxConfigFile>(configPath);
}

export async function loadRunxWorkspaceConfigFile(configPath: string): Promise<RunxWorkspaceConfigFile> {
  return await loadOptionalJsonFile<RunxWorkspaceConfigFile>(configPath);
}

export async function loadRunxWorkspacePolicy(
  env: NodeJS.ProcessEnv,
  options: PathResolutionOptions = {},
): Promise<RunxWorkspacePolicy> {
  const config = await loadRunxWorkspaceConfigFile(resolveRunxWorkspaceConfigPath(env, options));
  return {
    strictCliToolInlineCode:
      parseBooleanEnv(env.RUNX_STRICT_INLINE_CLI_TOOL_CODE)
      ?? config.policy?.strict_cli_tool_inline_code
      ?? false,
  };
}

async function loadOptionalJsonFile<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {} as T;
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

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
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

export function isRemoteRegistryUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

async function readProfileState(
  skillDirectory: string,
  skillName: string,
): Promise<{ readonly profileDocument: string; readonly profileSourcePath: string } | undefined> {
  const profileStatePath = path.join(skillDirectory, ".runx", "profile.json");
  const profileState = await readOptionalFile(profileStatePath);
  if (!profileState) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(profileState);
  } catch (error) {
    throw new Error(`Skill profile state is not valid JSON: ${profileStatePath}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Skill profile state must be an object: ${profileStatePath}`);
  }

  const profile = parsed.profile;
  if (!isRecord(profile) || typeof profile.document !== "string" || profile.document.length === 0) {
    return undefined;
  }

  validateBindingManifestSkill(profileStatePath, profile.document, skillName);
  return {
    profileDocument: profile.document,
    profileSourcePath: profileStatePath,
  };
}

async function readSkillProfile(
  skillDirectory: string,
  skillName: string,
): Promise<{ readonly profileDocument: string; readonly profileSourcePath: string } | undefined> {
  const candidatePath = path.join(skillDirectory, "X.yaml");
  const manifestText = await readOptionalFile(candidatePath);
  if (!manifestText) {
    return undefined;
  }
  validateBindingManifestSkill(candidatePath, manifestText, skillName);
  return {
    profileDocument: manifestText,
    profileSourcePath: candidatePath,
  };
}

function collectBindingRoots(start: string): readonly string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  let current = path.resolve(start);
  while (true) {
    for (const candidate of [path.join(current, "bindings")]) {
      if (existsSync(candidate) && !seen.has(candidate)) {
        roots.push(candidate);
        seen.add(candidate);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return roots;
}

async function readWorkspaceProfile(
  skillDirectory: string,
  bindingRoot: string,
  skillName: string,
): Promise<{ readonly profileDocument: string; readonly profileSourcePath: string } | undefined> {
  const locator = resolveBindingLocator(skillDirectory, bindingRoot);
  if (!locator) {
    return undefined;
  }
  if (locator.skillName !== skillName) {
    throw new Error(
      `Skill package '${skillDirectory}' resolves to binding path ${locator.owner}/${locator.skillName}, but SKILL.md declares '${skillName}'.`,
    );
  }

  const candidatePath = path.join(bindingRoot, locator.owner, locator.skillName, "X.yaml");
  if (!existsSync(candidatePath)) {
    return undefined;
  }

  const manifestText = await readOptionalFile(candidatePath);
  if (!manifestText) {
    return undefined;
  }
  validateBindingManifestSkill(candidatePath, manifestText, skillName);
  return {
    profileDocument: manifestText,
    profileSourcePath: candidatePath,
  };
}

function validateBindingManifestSkill(candidatePath: string, manifestText: string, skillName: string): void {
  const manifest = validateRunnerManifest(parseRunnerManifestYaml(manifestText));
  if (manifest.skill && manifest.skill !== skillName) {
    throw new Error(`Binding manifest skill '${manifest.skill}' does not match skill '${skillName}': ${candidatePath}`);
  }
}

function resolveBindingLocator(
  skillDirectory: string,
  bindingRoot: string,
): { readonly owner: string; readonly skillName: string } | undefined {
  const bindingContainer = path.dirname(bindingRoot);
  const relativeSkillPath = path.relative(bindingContainer, skillDirectory);
  if (
    !relativeSkillPath
    || relativeSkillPath.startsWith("..")
    || path.isAbsolute(relativeSkillPath)
  ) {
    return undefined;
  }

  const segments = relativeSkillPath.split(path.sep).filter((segment) => segment.length > 0);
  const skillSegments =
    segments[0] === "skills"
      ? segments.slice(1)
      : undefined;
  if (!skillSegments || skillSegments.length === 0) {
    return undefined;
  }
  if (skillSegments.length === 1) {
    return {
      owner: "runx",
      skillName: skillSegments[0]!,
    };
  }
  if (skillSegments.length === 2) {
    return {
      owner: skillSegments[0]!,
      skillName: skillSegments[1]!,
    };
  }
  return undefined;
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
