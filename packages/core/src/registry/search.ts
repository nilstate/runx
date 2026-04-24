import { runxLinkForVersion } from "./links.js";
import { deriveTrustSignals } from "./trust.js";
import type { SkillSearchResult } from "../marketplaces/index.js";
import type { RegistrySkillVersion, RegistryStore, RegistryTrustTier } from "./store.js";

export type RegistrySearchResult = SkillSearchResult & {
  readonly source: "runx-registry";
  readonly trust_tier: RegistryTrustTier;
};

export async function searchRegistry(
  store: RegistryStore,
  query: string,
  options: { readonly limit?: number; readonly registryUrl?: string } = {},
): Promise<readonly RegistrySearchResult[]> {
  const normalizedQuery = normalize(query);
  const skills = await store.listSkills();
  const latestVersions = skills.map((skill) => skill.versions[skill.versions.length - 1]).filter(isDefined);
  const matches = latestVersions
    .filter((version) => normalizedQuery.length === 0 || searchableText(version).includes(normalizedQuery))
    .sort((left, right) => left.skill_id.localeCompare(right.skill_id))
    .slice(0, options.limit ?? 20);

  return matches.map((version) => {
    const link = runxLinkForVersion(version, options.registryUrl);
    return normalizeRegistrySearchResult({
      skill_id: version.skill_id,
      name: version.name,
      summary: version.description,
      owner: version.owner,
      version: version.version,
      digest: version.digest,
      source_type: version.source_type,
      trust_tier: version.trust_tier,
      required_scopes: version.required_scopes,
      tags: version.tags,
      profile_mode: version.profile_document ? "profiled" : "portable",
      runner_names: version.runner_names,
      profile_digest: version.profile_digest,
      profile_trust_tier: version.profile_document ? version.trust_tier : undefined,
      trust_signals: deriveTrustSignals(version),
      add_command: link.install_command,
      run_command: link.run_command,
    });
  });
}

export function normalizeRegistrySearchResult(
  input: Omit<RegistrySearchResult, "source" | "source_label">,
): RegistrySearchResult {
  return {
    ...input,
    source: "runx-registry",
    source_label: "runx registry",
  };
}

function searchableText(version: RegistrySkillVersion): string {
  return normalize(
    [
      version.skill_id,
      version.name,
      version.description,
      version.owner,
      version.source_type,
      ...version.runner_names,
      ...version.tags,
    ].filter(isDefined).join(" "),
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
