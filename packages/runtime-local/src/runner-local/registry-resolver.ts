import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  resolveRegistrySkill,
  type RegistrySkillResolution,
  type RegistryStore,
} from "@runxhq/core/registry";
import { readOptionalFile } from "@runxhq/core/util";

export interface ParsedRegistryRef {
  readonly kind: "registry";
  readonly skillId: string;
  readonly owner: string;
  readonly name: string;
  readonly version?: string;
  readonly raw: string;
}

const REGISTRY_REF_PATTERN = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*(?:@[a-z0-9._-]+)?$/i;

export function isRegistryRef(value: string): boolean {
  if (!value || value.length === 0) {
    return false;
  }
  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("/")) {
    return false;
  }
  return REGISTRY_REF_PATTERN.test(value);
}

export function parseRegistryRef(value: string): ParsedRegistryRef {
  if (!isRegistryRef(value)) {
    throw new Error(
      `Invalid registry ref '${value}'. Expected '<owner>/<name>' or '<owner>/<name>@<version>'.`,
    );
  }
  const atIndex = value.lastIndexOf("@");
  const hasVersion = atIndex > 0;
  const skillId = hasVersion ? value.slice(0, atIndex) : value;
  const version = hasVersion ? value.slice(atIndex + 1) : undefined;
  const slashIndex = skillId.indexOf("/");
  const owner = skillId.slice(0, slashIndex);
  const name = skillId.slice(slashIndex + 1);
  return {
    kind: "registry",
    skillId,
    owner,
    name,
    version,
    raw: value,
  };
}

export interface MaterializeRegistrySkillOptions {
  readonly ref: string;
  readonly store: RegistryStore;
  readonly cacheDir: string;
}

export interface MaterializedRegistrySkill {
  readonly skillDirectory: string;
  readonly skillPath: string;
  readonly resolution: RegistrySkillResolution;
}

export async function materializeRegistrySkill(
  options: MaterializeRegistrySkillOptions,
): Promise<MaterializedRegistrySkill> {
  const parsed = parseRegistryRef(options.ref);
  const resolution = await lookupRegistrySkill(options.store, parsed);

  if (!resolution) {
    const available = await safeListVersions(options.store, parsed.skillId);
    if (parsed.version && available.length > 0) {
      throw new Error(
        `Registry skill '${parsed.skillId}@${parsed.version}' not found (available: ${available.join(", ")}).`,
      );
    }
    throw new Error(`Registry skill '${parsed.skillId}' not found in registry.`);
  }

  const skillDirectory = cachePathFor(options.cacheDir, resolution);
  const skillPath = path.join(skillDirectory, "SKILL.md");
  const markerPath = path.join(skillDirectory, ".runx-registry-digest");
  const profilePath = path.join(skillDirectory, "X.yaml");
  const expectedMarker = `${JSON.stringify({
    digest: resolution.digest,
    profile_digest: resolution.profile_digest ?? null,
  })}\n`;
  const existingMarker = await readOptionalFile(markerPath);

  if (existingMarker !== expectedMarker || !existsSync(skillPath)) {
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(skillPath, resolution.markdown, "utf8");
    if (resolution.profile_document) {
      await writeFile(profilePath, resolution.profile_document, "utf8");
    } else {
      await rm(profilePath, { force: true });
    }
    await writeFile(markerPath, expectedMarker, "utf8");
  }

  return { skillDirectory, skillPath, resolution };
}

export function defaultRegistrySkillCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.RUNX_SKILL_CACHE?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".runx", "cache", "skills");
}

async function lookupRegistrySkill(
  store: RegistryStore,
  parsed: ParsedRegistryRef,
): Promise<RegistrySkillResolution | undefined> {
  try {
    return await resolveRegistrySkill(store, parsed.skillId, { version: parsed.version });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Registry lookup failed for '${parsed.raw}': ${message}`);
  }
}

async function safeListVersions(store: RegistryStore, skillId: string): Promise<string[]> {
  try {
    const versions = await store.listVersions(skillId);
    return versions.map((version) => version.version);
  } catch {
    return [];
  }
}

function cachePathFor(cacheDir: string, resolution: RegistrySkillResolution): string {
  const slashIndex = resolution.skill_id.indexOf("/");
  const owner = resolution.skill_id.slice(0, slashIndex);
  const name = resolution.skill_id.slice(slashIndex + 1);
  const digestSlug = resolution.digest.slice(0, 16);
  return path.join(cacheDir, owner, name, resolution.version, digestSlug);
}

