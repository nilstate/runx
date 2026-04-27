import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
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
} from "@runxhq/runtime-local";

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
  return cache.skillPath;
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
  try {
    const raw = readFileSync(new URL("./official-skills.lock.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as readonly OfficialSkillLockEntry[];
    cachedOfficialSkillLock = Array.isArray(parsed) ? parsed : [];
    return cachedOfficialSkillLock;
  } catch {
    cachedOfficialSkillLock = [];
    return cachedOfficialSkillLock;
  }
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
