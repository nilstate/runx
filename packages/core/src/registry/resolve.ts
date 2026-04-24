import { runxLinkForVersion } from "./links.js";
import { slugify, type RegistrySkillVersion, type RegistryStore, type RegistryTrustTier } from "./store.js";

export interface RegistrySkillResolution {
  readonly markdown: string;
  readonly profile_document?: string;
  readonly profile_digest?: string;
  readonly runner_names: readonly string[];
  readonly skill_id: string;
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly source: "runx-registry";
  readonly source_label: "runx registry";
  readonly source_type: string;
  readonly trust_tier: RegistryTrustTier;
  readonly registry_url?: string;
  readonly add_command: string;
  readonly run_command: string;
}

export interface ResolveRegistrySkillOptions {
  readonly version?: string;
  readonly registryUrl?: string;
}

export async function resolveRegistrySkill(
  store: RegistryStore,
  ref: string,
  options: ResolveRegistrySkillOptions = {},
): Promise<RegistrySkillResolution | undefined> {
  const parsed = parseRegistrySkillRef(ref);
  const version = options.version ?? parsed.version;
  const record = parsed.skillId.includes("/")
    ? await store.getVersion(parsed.skillId, version)
    : await resolveByName(store, parsed.skillId, version);

  if (!record) {
    return undefined;
  }

  const link = runxLinkForVersion(record, options.registryUrl);
  return {
    markdown: record.markdown,
    profile_document: record.profile_document,
    profile_digest: record.profile_digest,
    runner_names: record.runner_names,
    skill_id: record.skill_id,
    name: record.name,
    version: record.version,
    digest: record.digest,
    source: "runx-registry",
    source_label: "runx registry",
    source_type: record.source_type,
    trust_tier: record.trust_tier,
    registry_url: options.registryUrl,
    add_command: link.install_command,
    run_command: link.run_command,
  };
}

export function parseRegistrySkillRef(ref: string): { readonly skillId: string; readonly version?: string } {
  const withoutProtocol = ref.startsWith("runx://skill/")
    ? decodeURIComponent(ref.slice("runx://skill/".length))
    : ref;
  const withoutPrefix = withoutProtocol.replace(/^(registry|runx-registry):/, "");
  const atIndex = withoutPrefix.lastIndexOf("@");

  if (atIndex <= 0) {
    return { skillId: withoutPrefix };
  }

  return {
    skillId: withoutPrefix.slice(0, atIndex),
    version: withoutPrefix.slice(atIndex + 1) || undefined,
  };
}

async function resolveByName(
  store: RegistryStore,
  name: string,
  version?: string,
): Promise<RegistrySkillVersion | undefined> {
  const normalized = slugify(name);
  const matches = (await store.listSkills()).filter(
    (skill) => skill.name === normalized || skill.skill_id.endsWith(`/${normalized}`),
  );

  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    throw new Error(`Registry ref '${name}' is ambiguous. Use '<owner>/<name>' instead.`);
  }

  return await store.getVersion(matches[0].skill_id, version);
}
