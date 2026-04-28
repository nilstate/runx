import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireRegistrySkill, type AcquiredRegistrySkill } from "@runxhq/core/registry";
import { buildPublisherAttestations, defaultRegistryPublisher, splitSkillId } from "@runxhq/core/registry";
import { asRecord, hashString, readOptionalFile } from "@runxhq/core/util";

export interface OfficialSkillLockEntry {
  readonly skill_id: string;
  readonly version: string;
  readonly digest: string;
}

export interface EnsureOfficialSkillCachedOptions {
  readonly cacheRoot: string;
  readonly registryBaseUrl: string;
  readonly installationId: string;
  readonly entry: OfficialSkillLockEntry;
  readonly fetchImpl?: typeof fetch;
}

export async function ensureOfficialSkillCached(
  options: EnsureOfficialSkillCachedOptions,
): Promise<{
  readonly skillPath: string;
  readonly fromCache: boolean;
  readonly acquisition: AcquiredRegistrySkill;
}> {
  const skillPath = officialSkillCachePath(options.cacheRoot, options.entry);
  const cachedMarkdown = await readOptionalFile(path.join(skillPath, "SKILL.md"));
  if (cachedMarkdown && hashString(cachedMarkdown) === options.entry.digest) {
    await syncPackagedRuntimeAssets(skillPath, options.entry.skill_id);
    const publisher = defaultRegistryPublisher(ownerFromSkillId(options.entry.skill_id));
    return {
      skillPath,
      fromCache: true,
      acquisition: {
        skill_id: options.entry.skill_id,
        owner: ownerFromSkillId(options.entry.skill_id),
        name: nameFromSkillId(options.entry.skill_id),
        version: options.entry.version,
        digest: options.entry.digest,
        markdown: cachedMarkdown,
        profile_document: await readProfileDocumentState(skillPath),
        trust_tier: "first_party",
        publisher,
        attestations: buildPublisherAttestations(publisher, "first_party", new Date().toISOString()),
        runner_names: [],
        install_count: 0,
      },
    };
  }

  const acquisition = await acquireRegistrySkill(options.entry.skill_id, {
    baseUrl: options.registryBaseUrl,
    installationId: options.installationId,
    version: options.entry.version,
    fetchImpl: options.fetchImpl,
  });
  const computedDigest = hashString(acquisition.markdown);
  if (
    acquisition.version !== options.entry.version
    || acquisition.digest !== options.entry.digest
    || computedDigest !== options.entry.digest
  ) {
    throw new Error(
      `Official skill verification failed for ${options.entry.skill_id}: expected ${options.entry.version} sha256:${options.entry.digest}, received ${acquisition.version} sha256:${acquisition.digest} (computed sha256:${computedDigest}).`,
    );
  }

  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), acquisition.markdown, "utf8");
  await writeProfileState(skillPath, acquisition);
  await syncPackagedRuntimeAssets(skillPath, acquisition.skill_id);
  return {
    skillPath,
    fromCache: false,
    acquisition,
  };
}

export function officialSkillCachePath(cacheRoot: string, entry: OfficialSkillLockEntry): string {
  const [owner, name] = splitSkillId(entry.skill_id);
  return path.join(cacheRoot, owner, name, entry.version);
}

let cachedCliSkillsRoot: string | undefined | null;

function ownerFromSkillId(skillId: string): string {
  return splitSkillId(skillId)[0];
}

function nameFromSkillId(skillId: string): string {
  return splitSkillId(skillId)[1];
}

async function syncPackagedRuntimeAssets(targetSkillPath: string, skillId: string): Promise<void> {
  const packagedSkillDir = resolvePackagedOfficialSkillDir(skillId);
  if (!packagedSkillDir) {
    return;
  }
  const entries = await readdir(packagedSkillDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name === "SKILL.md") {
      continue;
    }
    const sourcePath = path.join(packagedSkillDir, entry.name);
    const targetPath = path.join(targetSkillPath, entry.name);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, await readFile(sourcePath));
  }
}

function resolvePackagedOfficialSkillDir(skillId: string): string | undefined {
  const skillsRoot = resolveCliSkillsRoot();
  if (!skillsRoot) {
    return undefined;
  }
  const candidate = path.join(skillsRoot, nameFromSkillId(skillId));
  return existsSync(candidate) ? candidate : undefined;
}

function resolveCliSkillsRoot(): string | undefined {
  if (cachedCliSkillsRoot !== undefined) {
    return cachedCliSkillsRoot ?? undefined;
  }
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let index = 0; index < 10; index += 1) {
      const packageJsonPath = path.join(dir, "package.json");
      if (existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { readonly name?: string };
          if (pkg.name === "@runxhq/cli") {
            const skillsRoot = path.join(dir, "skills");
            cachedCliSkillsRoot = existsSync(skillsRoot) ? skillsRoot : null;
            return cachedCliSkillsRoot ?? undefined;
          }
        } catch {
          // ignore malformed package metadata and keep walking
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    dir = path.dirname(fileURLToPath(import.meta.url));
    for (let index = 0; index < 10; index += 1) {
      const skillsRoot = path.join(dir, "skills");
      if (existsSync(skillsRoot)) {
        cachedCliSkillsRoot = skillsRoot;
        return skillsRoot;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch {
    cachedCliSkillsRoot = null;
    return undefined;
  }
  cachedCliSkillsRoot = null;
  return undefined;
}

async function readProfileDocumentState(skillPath: string): Promise<string | undefined> {
  const state = await readOptionalFile(path.join(skillPath, ".runx", "profile.json"));
  if (!state) {
    return undefined;
  }
  const parsed = asRecord(JSON.parse(state));
  const profile = asRecord(parsed?.profile);
  return typeof profile?.document === "string" ? profile.document : undefined;
}

async function writeProfileState(skillPath: string, acquisition: AcquiredRegistrySkill): Promise<void> {
  const profileStatePath = path.join(skillPath, ".runx", "profile.json");
  if (!acquisition.profile_document) {
    return;
  }
  await mkdir(path.dirname(profileStatePath), { recursive: true });
  await writeFile(
    profileStatePath,
    `${JSON.stringify(
      {
        schema_version: "runx.skill-profile.v1",
        skill: {
          name: acquisition.name,
          path: "SKILL.md",
          digest: acquisition.digest,
        },
        profile: {
          document: acquisition.profile_document,
          digest: acquisition.profile_digest,
          runner_names: acquisition.runner_names,
        },
        origin: {
          source: "runx-registry",
          skill_id: acquisition.skill_id,
          version: acquisition.version,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
