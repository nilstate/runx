import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord } from "../util/types.js";
import { safeReadDirNames as safeReaddir } from "../util/fs.js";
import {
  optionalBoolean,
  optionalString as optionalNonEmptyString,
  requireBoolean,
  requireString as requireNonEmptyString,
} from "../util/validators.js";

export type RegistryTrustTier = "first_party" | "verified" | "community";
export type RegistryPublisherKind = "organization" | "user" | "team" | "service" | "publisher";
export type RegistryAttestationKind = "source" | "publisher" | "verification";
export type RegistryAttestationStatus = "verified" | "declared";

export interface RegistryPublisher {
  readonly kind: RegistryPublisherKind;
  readonly id: string;
  readonly handle?: string;
  readonly display_name?: string;
}

export interface RegistryAttestation {
  readonly kind: RegistryAttestationKind;
  readonly id: string;
  readonly status: RegistryAttestationStatus;
  readonly summary: string;
  readonly source?: string;
  readonly issued_at?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
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
  readonly trust_tier: RegistryTrustTier;
  readonly catalog_kind?: "skill" | "graph";
  readonly catalog_audience?: "public" | "builder" | "operator";
  readonly catalog_visibility?: "public" | "private";
  readonly source_metadata?: RegistrySourceMetadata;
  readonly attestations?: readonly RegistryAttestation[];
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
    const files = await safeReaddir(skillDir);

    const versions = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .slice()
        .sort()
        .map(async (file) => normalizeRegistrySkillVersion(JSON.parse(await readFile(path.join(skillDir, file), "utf8")))),
    );
    return versions.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.version.localeCompare(right.version));
  }

  async listSkills(): Promise<readonly RegistrySkill[]> {
    const owners = await safeReaddir(this.root);

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

export function normalizeRegistrySkillVersion(value: unknown): RegistrySkillVersion {
  if (!isRecord(value)) {
    throw new Error("Registry version payload must be an object.");
  }
  const owner = requireNonEmptyString(value.owner, "registry_version.owner");
  const createdAt = requireNonEmptyString(value.created_at, "registry_version.created_at");
  const publisher = normalizeRegistryVersionPublisher(value.publisher, owner);
  const trustTier = normalizeRegistryVersionTrustTier(value.trust_tier);
  const sourceMetadata = validateRegistrySourceMetadata(value.source_metadata, "registry_version.source_metadata");
  const attestations = validateRegistryAttestations(value.attestations, "registry_version.attestations");
  return {
    ...(value as unknown as RegistrySkillVersion),
    owner,
    publisher,
    runner_names: normalizeStringArray(value.runner_names, "registry_version.runner_names"),
    trust_tier: trustTier,
    catalog_kind: value.catalog_kind === "graph" ? "graph" : "skill",
    catalog_audience: value.catalog_audience === "builder" || value.catalog_audience === "operator" ? value.catalog_audience : "public",
    catalog_visibility: value.catalog_visibility === "private" ? "private" : "public",
    source_metadata: sourceMetadata,
    attestations: normalizeRegistryAttestations(attestations, sourceMetadata, publisher, trustTier, createdAt),
    required_scopes: normalizeStringArray(value.required_scopes, "registry_version.required_scopes"),
    tags: normalizeStringArray(value.tags, "registry_version.tags"),
    updated_at: typeof value.updated_at === "string" && value.updated_at.length > 0 ? value.updated_at : createdAt,
  };
}

export function createFileRegistryStore(root: string): RegistryStore {
  return new FileRegistryStore(root);
}

export function buildSkillId(owner: string, name: string): string {
  return `${slugify(owner)}/${slugify(name)}`;
}

export function splitSkillId(skillId: string): readonly [string, string] {
  const parts = skillId.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid registry skill id '${skillId}'. Expected '<owner>/<name>'.`);
  }
  return [parts[0], parts[1]];
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


export function validateRegistryPublisher(value: unknown, label = "publisher"): RegistryPublisher {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const kind = value.kind;
  if (
    kind !== "organization"
    && kind !== "user"
    && kind !== "team"
    && kind !== "service"
    && kind !== "publisher"
  ) {
    throw new Error(`${label}.kind must be one of organization, user, team, service, or publisher.`);
  }
  return {
    kind,
    id: requireNonEmptyString(value.id, `${label}.id`),
    handle: optionalNonEmptyString(value.handle, `${label}.handle`),
    display_name: optionalNonEmptyString(value.display_name, `${label}.display_name`),
  };
}

function normalizeRegistryVersionPublisher(value: unknown, owner: string): RegistryPublisher {
  if (isRecord(value) && value.kind === undefined && value.type === "placeholder") {
    return {
      kind: "publisher",
      id: optionalNonEmptyString(value.id, "registry_version.publisher.id") ?? owner,
      handle: optionalNonEmptyString(value.handle, "registry_version.publisher.handle"),
      display_name: optionalNonEmptyString(value.display_name, "registry_version.publisher.display_name"),
    };
  }
  return validateRegistryPublisher(value, "registry_version.publisher");
}

function normalizeRegistryVersionTrustTier(value: unknown): RegistryTrustTier {
  if (value === undefined || value === null) {
    return "community";
  }
  return validateRegistryTrustTier(value, "registry_version.trust_tier");
}

export function validateRegistryTrustTier(value: unknown, label = "trust_tier"): RegistryTrustTier {
  if (value === "first_party" || value === "verified" || value === "community") {
    return value;
  }
  throw new Error(`${label} must be one of first_party, verified, or community.`);
}

export function validateRegistryAttestations(
  value: unknown,
  label = "attestations",
): readonly RegistryAttestation[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided.`);
  }
  return value.map((entry, index) => validateRegistryAttestation(entry, `${label}[${index}]`));
}

function validateRegistryAttestation(value: unknown, label: string): RegistryAttestation {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const kind = value.kind;
  if (kind !== "source" && kind !== "publisher" && kind !== "verification") {
    throw new Error(`${label}.kind must be one of source, publisher, or verification.`);
  }
  const status = value.status;
  if (status !== "verified" && status !== "declared") {
    throw new Error(`${label}.status must be one of verified or declared.`);
  }
  const metadata = value.metadata;
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new Error(`${label}.metadata must be an object when provided.`);
  }
  return {
    kind,
    id: requireNonEmptyString(value.id, `${label}.id`),
    status,
    summary: requireNonEmptyString(value.summary, `${label}.summary`),
    source: optionalNonEmptyString(value.source, `${label}.source`),
    issued_at: optionalNonEmptyString(value.issued_at, `${label}.issued_at`),
    metadata: metadata as Readonly<Record<string, unknown>> | undefined,
  };
}

function normalizeRegistryAttestations(
  attestations: readonly RegistryAttestation[] | undefined,
  sourceMetadata: RegistrySourceMetadata | undefined,
  publisher: RegistryPublisher,
  trustTier: RegistryTrustTier,
  createdAt: string,
): readonly RegistryAttestation[] | undefined {
  const normalized = new Map<string, RegistryAttestation>();
  const publisherLabel = publisher.display_name ?? publisher.handle ?? publisher.id;
  normalized.set(`publisher:publisher:${publisher.id}`, {
    kind: "publisher",
    id: `publisher:${publisher.id}`,
    status: trustTier === "community" ? "declared" : "verified",
    summary: publisherLabel,
    issued_at: createdAt,
    metadata: {
      publisher_id: publisher.id,
      publisher_kind: publisher.kind,
      publisher_handle: publisher.handle,
      publisher_display_name: publisher.display_name,
      trust_tier: trustTier,
    },
  });
  if (sourceMetadata) {
    const id = `${sourceMetadata.provider}_source`;
    normalized.set(`source:${id}`, {
      kind: "source",
      id,
      status: "verified",
      summary: `${sourceMetadata.provider}:${sourceMetadata.repo}@${sourceMetadata.sha}`,
      source: sourceMetadata.repo_url,
      issued_at: createdAt,
      metadata: {
        repo: sourceMetadata.repo,
        ref: sourceMetadata.ref,
        sha: sourceMetadata.sha,
        event: sourceMetadata.event,
        skill_path: sourceMetadata.skill_path,
        profile_path: sourceMetadata.profile_path,
      },
    });
  }
  for (const attestation of attestations ?? []) {
    normalized.set(`${attestation.kind}:${attestation.id}`, attestation);
  }
  return normalized.size > 0 ? Array.from(normalized.values()) : undefined;
}

function validateRegistrySourceMetadata(
  value: unknown,
  label = "source_metadata",
): RegistrySourceMetadata | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object when provided.`);
  }
  const provider = value.provider;
  if (provider !== "github") {
    throw new Error(`${label}.provider must be github.`);
  }
  const event = value.event;
  if (event !== "enrollment" && event !== "push" && event !== "tag" && event !== "tombstone") {
    throw new Error(`${label}.event must be one of enrollment, push, tag, or tombstone.`);
  }
  return {
    provider,
    repo: requireNonEmptyString(value.repo, `${label}.repo`),
    repo_url: requireNonEmptyString(value.repo_url, `${label}.repo_url`),
    skill_path: requireNonEmptyString(value.skill_path, `${label}.skill_path`),
    profile_path: optionalNonEmptyString(value.profile_path, `${label}.profile_path`),
    ref: requireNonEmptyString(value.ref, `${label}.ref`),
    sha: requireNonEmptyString(value.sha, `${label}.sha`),
    default_branch: requireNonEmptyString(value.default_branch, `${label}.default_branch`),
    event,
    immutable: requireBoolean(value.immutable, `${label}.immutable`),
    live: requireBoolean(value.live, `${label}.live`),
    tombstoned: optionalBoolean(value.tombstoned, `${label}.tombstoned`),
    tag: optionalNonEmptyString(value.tag, `${label}.tag`),
    publisher_handle: optionalNonEmptyString(value.publisher_handle, `${label}.publisher_handle`),
  };
}

function normalizeStringArray(value: unknown, label: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((entry, index) => requireNonEmptyString(entry, `${label}[${index}]`));
}


