import { hashString } from "../receipts/index.js";
import {
  parseRunnerManifestYaml,
  parseSkillMarkdown,
  validateRunnerManifest,
  type CatalogMetadata,
  validateSkill,
  type SkillRunnerManifest,
  type ValidatedSkill,
} from "../parser/index.js";
import { isRecord } from "../util/types.js";
import { unique } from "../util/array.js";

import { buildSkillId, type RegistrySkillVersion, type RegistrySourceMetadata, type RegistryStore } from "./store.js";
import {
  buildPublisherAttestations,
  buildSourceAttestations,
  defaultRegistryPublisher,
  deriveRegistryTrustTier,
  mergeRegistryAttestations,
} from "./trust.js";
import type { RegistryAttestation, RegistryPublisher, RegistryTrustTier } from "./store.js";

export interface IngestSkillOptions {
  readonly owner?: string;
  readonly version?: string;
  readonly createdAt?: string;
  readonly profileDocument?: string;
  readonly publisher?: RegistryPublisher;
  readonly trustTier?: RegistryTrustTier;
  readonly attestations?: readonly RegistryAttestation[];
  readonly sourceMetadata?: RegistrySourceMetadata;
  readonly upsert?: boolean;
}

export interface CreateRegistrySkillVersionResult {
  readonly record: RegistrySkillVersion;
  readonly created: boolean;
}

export async function ingestSkillMarkdown(
  store: RegistryStore,
  markdown: string,
  options: IngestSkillOptions = {},
): Promise<RegistrySkillVersion> {
  return (await createRegistrySkillVersion(store, markdown, options)).record;
}

export async function createRegistrySkillVersion(
  store: RegistryStore,
  markdown: string,
  options: IngestSkillOptions = {},
): Promise<CreateRegistrySkillVersionResult> {
  const record = buildRegistrySkillVersion(markdown, options);
  const existing = await store.getVersion(record.skill_id, record.version);
  if (existing) {
    if (existing.digest !== record.digest || existing.profile_digest !== record.profile_digest) {
      if (!options.upsert) {
        throw new Error(`Registry version ${record.skill_id}@${record.version} already exists with a different digest.`);
      }
      return {
        record: await store.putVersion(record, { upsert: true }),
        created: false,
      };
    }
    return {
      record: await store.putVersion({
        ...record,
        created_at: existing.created_at,
      }),
      created: false,
    };
  }

  return {
    record: await store.putVersion(record),
    created: true,
  };
}

export function buildRegistrySkillVersion(markdown: string, options: IngestSkillOptions = {}): RegistrySkillVersion {
  const raw = parseSkillMarkdown(markdown);
  const skill = validateSkill(raw, { mode: "strict" });
  const digest = hashString(markdown);
  const bindingArtifact = buildBindingArtifact(skill, options.profileDocument);
  const catalog = resolveCatalogMetadata(bindingArtifact.manifest);
  const owner = options.owner ?? "local";
  const createdAt = options.createdAt ?? new Date().toISOString();
  const publisher = options.publisher ?? defaultRegistryPublisher(owner);
  const trustTier = options.trustTier ?? deriveRegistryTrustTier({ owner });
  const version = options.version ?? `sha-${defaultRegistryVersionSeed(digest, bindingArtifact.digest).slice(0, 12)}`;
  return {
    skill_id: buildSkillId(owner, skill.name),
    owner,
    name: skill.name,
    description: skill.description,
    version,
    digest,
    markdown,
    profile_document: options.profileDocument,
    profile_digest: bindingArtifact.digest,
    runner_names: bindingArtifact.runnerNames,
    source_type: skill.source.type,
    trust_tier: trustTier,
    catalog_kind: catalog.kind,
    catalog_audience: catalog.audience,
    catalog_visibility: catalog.visibility,
    source_metadata: options.sourceMetadata,
    attestations: mergeRegistryAttestations(
      buildPublisherAttestations(publisher, trustTier, createdAt),
      buildSourceAttestations(options.sourceMetadata, createdAt),
      options.attestations,
    ),
    required_scopes: unique([...extractScopes(skill), ...extractRunnerScopes(bindingArtifact.manifest)]),
    runtime: skill.runtime ?? recordField(skill.runx, "runtime") ?? extractRunnerRuntime(bindingArtifact.manifest),
    auth: skill.auth,
    risk: skill.risk ?? recordField(skill.runx, "risk"),
    runx: skill.runx,
    tags: unique([...extractTags(skill), ...extractRunnerTags(bindingArtifact.manifest)]),
    publisher,
    created_at: createdAt,
    updated_at: new Date().toISOString(),
  };
}

interface BindingArtifact {
  readonly digest?: string;
  readonly runnerNames: readonly string[];
  readonly manifest?: SkillRunnerManifest;
}

function buildBindingArtifact(skill: ValidatedSkill, profileDocument: string | undefined): BindingArtifact {
  if (!profileDocument) {
    return {
      runnerNames: [],
    };
  }
  const manifest = validateRunnerManifest(parseRunnerManifestYaml(profileDocument));
  if (manifest.skill && manifest.skill !== skill.name) {
    throw new Error(`Runner manifest skill '${manifest.skill}' does not match skill '${skill.name}'.`);
  }
  return {
    digest: hashString(profileDocument),
    runnerNames: Object.keys(manifest.runners),
    manifest,
  };
}

function defaultRegistryVersionSeed(markdownDigest: string, profileDigest: string | undefined): string {
  if (!profileDigest) {
    return markdownDigest;
  }
  return hashString(JSON.stringify({
    markdown_digest: markdownDigest,
    profile_digest: profileDigest,
  }));
}

function resolveCatalogMetadata(manifest: SkillRunnerManifest | undefined): CatalogMetadata {
  return manifest?.catalog ?? {
    kind: "skill",
    audience: "public",
    visibility: "public",
  };
}

function extractScopes(skill: ValidatedSkill): readonly string[] {
  const authScopes = recordArrayField(skill.auth, "scopes");
  const runxScopes = recordArrayField(skill.runx, "scopes");
  return unique([...authScopes, ...runxScopes]);
}

function extractRunnerScopes(manifest: SkillRunnerManifest | undefined): readonly string[] {
  if (!manifest) {
    return [];
  }
  return unique(
    Object.values(manifest.runners).flatMap((runner) => [
      ...recordArrayField(runner.auth, "scopes"),
      ...recordArrayField(runner.raw.runx, "scopes"),
    ]),
  );
}

function extractRunnerRuntime(manifest: SkillRunnerManifest | undefined): unknown {
  if (!manifest) {
    return undefined;
  }
  const runnersWithRuntime = Object.values(manifest.runners)
    .filter((runner) => runner.runtime !== undefined)
    .map((runner) => runner.name);
  return runnersWithRuntime.length > 0 ? { runners: runnersWithRuntime } : undefined;
}

function extractRunnerTags(manifest: SkillRunnerManifest | undefined): readonly string[] {
  if (!manifest) {
    return [];
  }
  return unique(Object.values(manifest.runners).flatMap((runner) => recordArrayField(runner.raw.runx, "tags")));
}

function extractTags(skill: ValidatedSkill): readonly string[] {
  return unique(recordArrayField(skill.runx, "tags"));
}

function recordArrayField(value: unknown, field: string): readonly string[] {
  if (!isRecord(value)) {
    return [];
  }
  const arrayValue = value[field];
  if (!Array.isArray(arrayValue)) {
    return [];
  }
  return arrayValue.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function recordField(value: unknown, field: string): unknown {
  return isRecord(value) ? value[field] : undefined;
}


