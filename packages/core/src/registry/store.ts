import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RegistryPublisher {
  readonly type: "placeholder";
  readonly id: string;
}

export interface RegistrySourceMetadata {
  readonly provider: "github";
  readonly repo: string;
  readonly repo_url: string;
  readonly skill_path: string;
  readonly profile_path?: string;
  readonly ref: string;
  readonly sha: string;
  readonly default_branch: string;
  readonly event: "enrollment" | "push" | "tag" | "tombstone";
  readonly immutable: boolean;
  readonly live: boolean;
  readonly tombstoned?: boolean;
  readonly tag?: string;
  readonly publisher_handle?: string;
}

export interface RegistrySkillVersion {
  readonly skill_id: string;
  readonly owner: string;
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  readonly digest: string;
  readonly markdown: string;
  readonly profile_document?: string;
  readonly profile_digest?: string;
  readonly runner_names: readonly string[];
  readonly source_type: string;
  readonly catalog_kind?: "skill" | "chain";
  readonly catalog_audience?: "public" | "builder" | "operator";
  readonly catalog_visibility?: "public" | "private";
  readonly source_metadata?: RegistrySourceMetadata;
  readonly required_scopes: readonly string[];
  readonly runtime?: unknown;
  readonly auth?: unknown;
  readonly risk?: unknown;
  readonly runx?: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
  readonly publisher: RegistryPublisher;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RegistrySkill {
  readonly skill_id: string;
  readonly owner: string;
  readonly name: string;
  readonly description?: string;
  readonly latest_version: string;
  readonly latest_digest: string;
  readonly versions: readonly RegistrySkillVersion[];
}

export interface PutVersionOptions {
  readonly upsert?: boolean;
}

export interface RegistryStore {
  readonly putVersion: (version: RegistrySkillVersion, options?: PutVersionOptions) => Promise<RegistrySkillVersion>;
  readonly getVersion: (skillId: string, version?: string) => Promise<RegistrySkillVersion | undefined>;
  readonly listVersions: (skillId: string) => Promise<readonly RegistrySkillVersion[]>;
  readonly listSkills: () => Promise<readonly RegistrySkill[]>;
}

export class FileRegistryStore implements RegistryStore {
  constructor(private readonly root: string) {}

  async putVersion(version: RegistrySkillVersion, options?: PutVersionOptions): Promise<RegistrySkillVersion> {
    const versionPath = this.versionPath(version.skill_id, version.version);
    await mkdir(path.dirname(versionPath), { recursive: true });

    const existing = await this.getVersion(version.skill_id, version.version);
    if (existing) {
      if (existing.digest !== version.digest || existing.profile_digest !== version.profile_digest) {
        if (!options?.upsert) {
          throw new Error(`Registry version ${version.skill_id}@${version.version} already exists with a different digest.`);
        }
        const upserted = { ...version, updated_at: new Date().toISOString() };
        await writeFile(versionPath, `${JSON.stringify(upserted, null, 2)}\n`, { flag: "w", mode: 0o600 });
        return upserted;
      }
      const refreshed = {
        ...version,
        created_at: existing.created_at,
        updated_at: new Date().toISOString(),
      };
      if (JSON.stringify(existing) !== JSON.stringify(refreshed)) {
        await writeFile(versionPath, `${JSON.stringify(refreshed, null, 2)}\n`, { flag: "w", mode: 0o600 });
      }
      return refreshed;
    }

    await writeFile(versionPath, `${JSON.stringify(version, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return version;
  }

  async getVersion(skillId: string, version?: string): Promise<RegistrySkillVersion | undefined> {
    const versions = await this.listVersions(skillId);
    if (versions.length === 0) {
      return undefined;
    }
    if (!version) {
      return versions[versions.length - 1];
    }
    return versions.find((candidate) => candidate.version === version);
  }

  async listVersions(skillId: string): Promise<readonly RegistrySkillVersion[]> {
    const skillDir = this.skillDir(skillId);
    let files: string[];
    try {
      files = await readdir(skillDir);
    } catch {
      return [];
    }

    const versions = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map(async (file) => normalizeRegistrySkillVersion(JSON.parse(await readFile(path.join(skillDir, file), "utf8")))),
    );
    return versions.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.version.localeCompare(right.version));
  }

  async listSkills(): Promise<readonly RegistrySkill[]> {
    let owners: string[];
    try {
      owners = await readdir(this.root);
    } catch {
      return [];
    }

    const skills: RegistrySkill[] = [];
    for (const owner of owners) {
      const ownerDir = path.join(this.root, owner);
      for (const name of await safeReaddir(ownerDir)) {
        const skillId = `${decodePart(owner)}/${decodePart(name)}`;
        const versions = await this.listVersions(skillId);
        const latest = versions[versions.length - 1];
        if (!latest) {
          continue;
        }
        skills.push({
          skill_id: skillId,
          owner: latest.owner,
          name: latest.name,
          description: latest.description,
          latest_version: latest.version,
          latest_digest: latest.digest,
          versions,
        });
      }
    }

    return skills.sort((left, right) => left.skill_id.localeCompare(right.skill_id));
  }

  private versionPath(skillId: string, version: string): string {
    return path.join(this.skillDir(skillId), `${encodePart(version)}.json`);
  }

  private skillDir(skillId: string): string {
    const [owner, name] = splitSkillId(skillId);
    return path.join(this.root, encodePart(owner), encodePart(name));
  }
}

function normalizeRegistrySkillVersion(value: RegistrySkillVersion): RegistrySkillVersion {
  return {
    ...value,
    runner_names: value.runner_names ?? [],
    catalog_kind: value.catalog_kind ?? "skill",
    catalog_audience: value.catalog_audience ?? "public",
    catalog_visibility: value.catalog_visibility ?? "public",
    updated_at: value.updated_at ?? value.created_at,
  };
}

export function createFileRegistryStore(root: string): RegistryStore {
  return new FileRegistryStore(root);
}

export function buildSkillId(owner: string, name: string): string {
  return `${slugify(owner)}/${slugify(name)}`;
}

export function splitSkillId(skillId: string): readonly [string, string] {
  const separator = skillId.indexOf("/");
  if (separator <= 0 || separator === skillId.length - 1) {
    throw new Error(`Invalid registry skill id '${skillId}'. Expected '<owner>/<name>'.`);
  }
  return [skillId.slice(0, separator), skillId.slice(separator + 1)];
}

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error("Registry slugs cannot be empty.");
  }
  return slug;
}

function encodePart(value: string): string {
  return encodeURIComponent(value);
}

function decodePart(value: string): string {
  return decodeURIComponent(value);
}

async function safeReaddir(dir: string): Promise<readonly string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
