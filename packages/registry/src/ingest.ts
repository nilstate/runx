import { hashString } from "../../receipts/src/index.js";
import {
  parseRunnerManifestYaml,
  parseSkillMarkdown,
  validateRunnerManifest,
  validateSkill,
  type SkillRunnerManifest,
  type ValidatedSkill,
} from "../../parser/src/index.js";

import { buildSkillId, type RegistrySkillVersion, type RegistryStore } from "./store.js";

export interface IngestSkillOptions {
  readonly owner?: string;
  readonly version?: string;
  readonly createdAt?: string;
  readonly xManifest?: string;
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
    if (existing.digest !== record.digest || existing.x_digest !== record.x_digest) {
      throw new Error(`Registry version ${record.skill_id}@${record.version} already exists with a different digest.`);
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
  const xArtifact = buildXArtifact(skill, options.xManifest);
  const owner = options.owner ?? "local";
  const version = options.version ?? `sha-${digest.slice(0, 12)}`;
  return {
    skill_id: buildSkillId(owner, skill.name),
    owner,
    name: skill.name,
    description: skill.description,
    version,
    digest,
    markdown,
    x_manifest: options.xManifest,
    x_digest: xArtifact.digest,
    runner_names: xArtifact.runnerNames,
    source_type: skill.source.type,
    required_scopes: unique([...extractScopes(skill), ...extractRunnerScopes(xArtifact.manifest)]),
    runtime: skill.runtime ?? recordField(skill.runx, "runtime") ?? extractRunnerRuntime(xArtifact.manifest),
    auth: skill.auth,
    risk: skill.risk ?? recordField(skill.runx, "risk"),
    runx: skill.runx,
    tags: unique([...extractTags(skill), ...extractRunnerTags(xArtifact.manifest)]),
    publisher: {
      type: "placeholder",
      id: owner,
    },
    created_at: options.createdAt ?? new Date().toISOString(),
  };
}

interface XArtifact {
  readonly digest?: string;
  readonly runnerNames: readonly string[];
  readonly manifest?: SkillRunnerManifest;
}

function buildXArtifact(skill: ValidatedSkill, xManifest: string | undefined): XArtifact {
  if (!xManifest) {
    return {
      runnerNames: [],
    };
  }
  const manifest = validateRunnerManifest(parseRunnerManifestYaml(xManifest));
  if (manifest.skill && manifest.skill !== skill.name) {
    throw new Error(`Runner manifest skill '${manifest.skill}' does not match skill '${skill.name}'.`);
  }
  return {
    digest: hashString(xManifest),
    runnerNames: Object.keys(manifest.runners),
    manifest,
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

function unique(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
