import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolvePathFromUserInput,
  resolveRunxGlobalHomeDir,
  resolveRunxOfficialSkillsDir,
  resolveRunxProjectDir,
  resolveRunxRegistryTarget,
  resolveSkillInstallRoot,
} from "@runxhq/core/config";
import {
  createFixtureMarketplaceAdapter,
  searchMarketplaceAdapters,
  type SkillSearchResult,
} from "@runxhq/core/marketplaces";
import {
  createFileRegistryStore,
  searchRemoteRegistry,
  searchRegistry,
} from "@runxhq/core/registry";
import {
  ensureOfficialSkillCached,
  type OfficialSkillLockEntry,
  type OfficialSkillResolver,
  type ParsedRegistryRef,
} from "@runxhq/runtime-local";

import { asRecord } from "@runxhq/core/util";

import { ensureRunxInstallState } from "./runx-state.js";

let cachedBundledSkillsDir: string | undefined | null = null;
let cachedOfficialSkillLock: readonly OfficialSkillLockEntry[] | undefined;

export function preferredRunCommand(skillName: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(skillName) ? `runx ${skillName}` : `runx skill ${skillName}`;
}

export async function runSkillSearch(
  query: string,
  sourceFilter: string | undefined,
  env: NodeJS.ProcessEnv,
  registryOverride?: string,
): Promise<readonly SkillSearchResult[]> {
  const results: SkillSearchResult[] = [];
  const normalizedSource = sourceFilter?.trim().toLowerCase();

  if (!normalizedSource || normalizedSource === "registry" || normalizedSource === "runx-registry") {
    const registryTarget = resolveRunxRegistryTarget(env, { registry: registryOverride });
    if (registryTarget.mode === "remote") {
      results.push(...(await searchRemoteRegistry(query, {
        baseUrl: registryTarget.registryUrl,
      })));
    } else {
      results.push(
        ...(await searchRegistry(createFileRegistryStore(registryTarget.registryPath), query, {
          registryUrl: registryTarget.registryUrl,
        })),
      );
    }
  }

  const marketplaceAdapters =
    env.RUNX_ENABLE_FIXTURE_MARKETPLACE === "1" &&
    (!normalizedSource || normalizedSource === "marketplace" || normalizedSource === "fixture-marketplace")
      ? [createFixtureMarketplaceAdapter()]
      : [];
  results.push(...(await searchMarketplaceAdapters(marketplaceAdapters, query)));

  if (!normalizedSource || normalizedSource === "bundled" || normalizedSource === "builtin") {
    results.push(...(await searchBundledSkills(query)));
  }

  return results;
}

export function resolveSkillReference(ref: string, env: NodeJS.ProcessEnv): string {
  const resolved = resolveLocalSkillReference(ref, env);
  if (resolved) {
    return resolved;
  }
  throw new Error(`Skill not found: ${ref}. Try \`runx search ${ref}\` to discover available skills.`);
}

export async function resolveRunnableSkillReference(ref: string, env: NodeJS.ProcessEnv): Promise<string> {
  const local = resolveLocalSkillReference(ref, env);
  if (local) {
    return local;
  }
  const official = officialSkillEntry(ref);
  if (!official) {
    throw new Error(`Skill not found: ${ref}. Try \`runx search ${ref}\` to discover available skills.`);
  }
  const globalHomeDir = resolveRunxGlobalHomeDir(env);
  const install = await ensureRunxInstallState(globalHomeDir);
  const registryBaseUrl = env.RUNX_REGISTRY_URL ?? "https://runx.ai";
  const cache = await ensureOfficialSkillCached({
    cacheRoot: resolveRunxOfficialSkillsDir(env),
    registryBaseUrl,
    installationId: install.state.installation_id,
    entry: official,
  });
  await rewriteOfficialSkillSiblingRefs(cache.skillPath, official.skill_id);
  return cache.skillPath;
}

export function createOfficialSkillResolver(env: NodeJS.ProcessEnv): OfficialSkillResolver {
  return {
    async resolve(parsed: ParsedRegistryRef): Promise<string | undefined> {
      const lock = loadOfficialSkillLock();
      const entry = lock.find((candidate) => candidate.skill_id === parsed.skillId);
      if (!entry) {
        return undefined;
      }
      if (parsed.version && entry.version !== parsed.version) {
        return undefined;
      }
      const globalHomeDir = resolveRunxGlobalHomeDir(env);
      const install = await ensureRunxInstallState(globalHomeDir);
      const registryBaseUrl = env.RUNX_REGISTRY_URL ?? "https://runx.ai";
      const cache = await ensureOfficialSkillCached({
        cacheRoot: resolveRunxOfficialSkillsDir(env),
        registryBaseUrl,
        installationId: install.state.installation_id,
        entry,
      });
      await rewriteOfficialSkillSiblingRefs(cache.skillPath, entry.skill_id);
      return cache.skillPath;
    },
  };
}

const SIBLING_SKILL_REF_PATTERN = /(\bskill:\s*)\.\.\/([A-Za-z0-9][A-Za-z0-9_-]*)\b/g;

export function rewriteSiblingSkillRefs(
  text: string,
  owner: string,
  siblingVersions: ReadonlyMap<string, string>,
): { readonly text: string; readonly didRewrite: boolean } {
  let didRewrite = false;
  const out = text.replace(SIBLING_SKILL_REF_PATTERN, (match, prefix, siblingName) => {
    const siblingVersion = siblingVersions.get(siblingName);
    if (!siblingVersion) {
      return match;
    }
    didRewrite = true;
    return `${prefix}${owner}/${siblingName}@${siblingVersion}`;
  });
  return { text: out, didRewrite };
}

async function rewriteOfficialSkillSiblingRefs(skillDir: string, ownerSkillId: string): Promise<void> {
  const owner = ownerSkillId.split("/")[0];
  if (!owner) {
    return;
  }
  const lock = loadOfficialSkillLock();
  const lockBySiblingName = new Map<string, string>();
  for (const entry of lock) {
    const [entryOwner, entryName] = entry.skill_id.split("/");
    if (entryOwner === owner && entryName) {
      lockBySiblingName.set(entryName, entry.version);
    }
  }
  if (lockBySiblingName.size === 0) {
    return;
  }

  const profilePath = path.join(skillDir, "X.yaml");
  if (existsSync(profilePath)) {
    const original = await readFile(profilePath, "utf8");
    const { text: rewritten, didRewrite } = rewriteSiblingSkillRefs(original, owner, lockBySiblingName);
    if (didRewrite) {
      await writeFile(profilePath, rewritten);
    }
  }

  const profileStatePath = path.join(skillDir, ".runx", "profile.json");
  if (existsSync(profileStatePath)) {
    const stateText = await readFile(profileStatePath, "utf8");
    const state = asRecord(JSON.parse(stateText));
    const profile = asRecord(state?.profile);
    const document = profile?.document;
    if (state && typeof document === "string") {
      const { text: rewrittenDocument, didRewrite } = rewriteSiblingSkillRefs(document, owner, lockBySiblingName);
      if (didRewrite) {
        const nextState = {
          ...state,
          profile: { ...(profile ?? {}), document: rewrittenDocument },
        };
        await writeFile(profileStatePath, `${JSON.stringify(nextState, null, 2)}\n`);
      }
    }
  }
}

async function searchBundledSkills(query: string): Promise<readonly SkillSearchResult[]> {
  const bundledDir = resolveBundledSkillsDir();
  if (!bundledDir || !existsSync(bundledDir)) return [];
  const entries = await readdir(bundledDir, { withFileTypes: true });
  const needle = query.trim().toLowerCase();
  const out: SkillSearchResult[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(bundledDir, entry.name, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;
    const raw = await readFile(skillMdPath, "utf8");
    const { name, description } = parseSkillFrontmatter(raw, entry.name);
    const hay = `${name}\n${description}`.toLowerCase();
    if (needle && !hay.includes(needle)) continue;
    const hasProfile = existsSync(path.join(path.dirname(bundledDir), "bindings", "runx", entry.name, "X.yaml"));
    out.push({
      skill_id: `runx/${name}`,
      name,
      summary: description,
      owner: "runx",
      source: "runx-registry",
      source_label: "runx (bundled)",
      source_type: "bundled",
      trust_tier: "first_party",
      required_scopes: [],
      tags: [],
      profile_mode: hasProfile ? "profiled" : "portable",
      runner_names: [],
      add_command: `runx add runx/${name}`,
      run_command: preferredRunCommand(name),
    });
  }
  return out;
}

function resolveBundledSkillsDir(): string | undefined {
  if (cachedBundledSkillsDir !== null) return cachedBundledSkillsDir ?? undefined;
  try {
    // Walk up from the compiled entry looking for the @runxhq/cli package root,
    // which owns a `skills/` sibling. Works across dev (src/), dist wrapper,
    // and nested-dist layouts without sentinel files.
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      const pkgJsonPath = path.join(dir, "package.json");
      if (existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
          if (pkg && pkg.name === "@runxhq/cli") {
            const skills = path.join(dir, "skills");
            cachedBundledSkillsDir = existsSync(skills) ? skills : undefined;
            return cachedBundledSkillsDir ?? undefined;
          }
        } catch {
          // ignore and keep walking
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    cachedBundledSkillsDir = undefined;
    return undefined;
  } catch {
    cachedBundledSkillsDir = undefined;
    return undefined;
  }
}

function officialSkillEntry(ref: string): OfficialSkillLockEntry | undefined {
  if (!/^[A-Za-z0-9_.-]+$/.test(ref)) {
    return undefined;
  }
  return loadOfficialSkillLock().find((entry) => entry.skill_id === `runx/${ref}`);
}

function loadOfficialSkillLock(): readonly OfficialSkillLockEntry[] {
  if (cachedOfficialSkillLock) {
    return cachedOfficialSkillLock;
  }
  const lockUrl = new URL("./official-skills.lock.json", import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(lockUrl, "utf8");
  } catch (error) {
    throw new Error(
      `Official skills lock file is missing at ${lockUrl.href}. The CLI install may be incomplete; reinstall to restore it. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Official skills lock file at ${lockUrl.href} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Official skills lock file at ${lockUrl.href} must contain a JSON array.`);
  }
  cachedOfficialSkillLock = parsed as readonly OfficialSkillLockEntry[];
  return cachedOfficialSkillLock;
}

function resolveLocalSkillReference(ref: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!ref) {
    throw new Error("Missing skill reference.");
  }
  const looksLikePath = ref.includes("/") || ref.includes(path.sep) || ref.startsWith(".") || ref.startsWith("~");
  if (looksLikePath) {
    const resolved = resolvePathFromUserInput(ref, env);
    assertSkillReferencePath(resolved);
    return resolved;
  }
  const directCandidate = resolvePathFromUserInput(ref, env);
  if (existsSync(directCandidate)) {
    assertSkillReferencePath(directCandidate);
    return directCandidate;
  }

  const projectSkillDir = path.join(resolveRunxProjectDir(env), "skills", ref);
  if (existsSync(path.join(projectSkillDir, "SKILL.md"))) {
    return projectSkillDir;
  }

  const installedSkillDir = path.join(resolveSkillInstallRoot(env), ref);
  if (existsSync(path.join(installedSkillDir, "SKILL.md"))) {
    return installedSkillDir;
  }

  return undefined;
}

function assertSkillReferencePath(resolved: string): void {
  if (path.extname(resolved).toLowerCase() === ".md" && path.basename(resolved).toLowerCase() !== "skill.md") {
    throw new Error(
      `Skill references must point to a skill package directory or SKILL.md. Flat markdown files are not supported: ${resolved}`,
    );
  }
}

function parseSkillFrontmatter(raw: string, fallbackName: string): { name: string; description: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  let name = fallbackName;
  let description = "";
  if (match) {
    for (const line of match[1].split("\n")) {
      const kv = line.match(/^(name|description):\s*(.*)$/);
      if (!kv) continue;
      const value = kv[2].trim().replace(/^["']|["']$/g, "");
      if (kv[1] === "name") name = value || fallbackName;
      else if (kv[1] === "description") description = value;
    }
  }
  return { name, description };
}
