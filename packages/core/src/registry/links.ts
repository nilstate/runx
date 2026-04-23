import type { RegistrySkillVersion, RegistryStore } from "./store.js";
import { splitSkillId } from "./store.js";

export interface RunxLinkResolution {
  readonly link: string;
  readonly skill_id: string;
  readonly version: string;
  readonly digest: string;
  readonly registry_url?: string;
  readonly install_command: string;
  readonly run_command: string;
}

export async function resolveRunxLink(
  store: RegistryStore,
  skillId: string,
  version?: string,
  registryUrl?: string,
): Promise<RunxLinkResolution | undefined> {
  const record = await store.getVersion(skillId, version);
  return record ? runxLinkForVersion(record, registryUrl) : undefined;
}

export function runxLinkForVersion(record: RegistrySkillVersion, registryUrl?: string): RunxLinkResolution {
  const ref = `${record.skill_id}@${record.version}`;
  const registryFlag = registryUrl ? ` --registry ${registryUrl}` : "";
  return {
    link: `runx://skill/${encodeURIComponent(record.skill_id)}@${encodeURIComponent(record.version)}`,
    skill_id: record.skill_id,
    version: record.version,
    digest: record.digest,
    registry_url: registryUrl,
    install_command: `runx add ${ref}${registryFlag}`,
    run_command: `runx ${record.name}`,
  };
}

export function runxSkillPagePath(skillId: string, version?: string): string {
  const [owner, name] = splitSkillId(skillId);
  const encodedOwner = encodeURIComponent(owner);
  const encodedName = encodeURIComponent(name);
  const encodedVersion = version ? `@${encodeURIComponent(version)}` : "";
  return `/x/${encodedOwner}/${encodedName}${encodedVersion}`;
}

export function runxSkillPageUrl(skillId: string, version: string | undefined, publicBaseUrl?: string): string {
  const baseUrl = (publicBaseUrl ?? "https://runx.ai").replace(/\/$/, "");
  return `${baseUrl}${runxSkillPagePath(skillId, version)}`;
}

export function runxSkillPageUrlForVersion(record: RegistrySkillVersion, publicBaseUrl?: string): string {
  return runxSkillPageUrl(record.skill_id, record.version, publicBaseUrl);
}
