import {
  deriveTrustSignals,
  runxLinkForVersion,
  type RegistrySkillVersion,
  type RegistryStore,
  type TrustSignal,
} from "../../../packages/registry/src/index.js";

export interface SkillPageVersion {
  readonly version: string;
  readonly digest: string;
  readonly created_at: string;
}

export interface SkillPageModel {
  readonly skill_id: string;
  readonly name: string;
  readonly description?: string;
  readonly owner: string;
  readonly version: string;
  readonly digest: string;
  readonly profile_digest?: string;
  readonly runner_names: readonly string[];
  readonly source_type: string;
  readonly required_scopes: readonly string[];
  readonly install_command: string;
  readonly run_command: string;
  readonly trust_signals: readonly TrustSignal[];
  readonly versions: readonly SkillPageVersion[];
}

export async function buildSkillPageModel(
  store: RegistryStore,
  skillId: string,
  version?: string,
  registryUrl?: string,
): Promise<SkillPageModel | undefined> {
  const record = await store.getVersion(skillId, version);
  if (!record) {
    return undefined;
  }
  const versions = await store.listVersions(skillId);
  return skillPageModelForVersion(record, versions, registryUrl);
}

export function skillPageModelForVersion(
  record: RegistrySkillVersion,
  versions: readonly RegistrySkillVersion[],
  registryUrl?: string,
): SkillPageModel {
  const link = runxLinkForVersion(record, registryUrl);
  return {
    skill_id: record.skill_id,
    name: record.name,
    description: record.description,
    owner: record.owner,
    version: record.version,
    digest: record.digest,
    profile_digest: record.profile_digest,
    runner_names: record.runner_names,
    source_type: record.source_type,
    required_scopes: record.required_scopes,
    install_command: link.install_command,
    run_command: link.run_command,
    trust_signals: deriveTrustSignals(record),
    versions: versions.map((candidate) => ({
      version: candidate.version,
      digest: candidate.digest,
      created_at: candidate.created_at,
    })),
  };
}
