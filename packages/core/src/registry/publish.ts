import { runxLinkForVersion, type RunxLinkResolution } from "./links.js";
import type { RegistryClient } from "./client.js";
import type { IngestSkillOptions } from "./ingest.js";
import type { RegistrySkillVersion } from "./store.js";

export interface PublishSkillMarkdownOptions extends IngestSkillOptions {
  readonly registryUrl?: string;
}

export interface PublishSkillMarkdownResult {
  readonly status: "published" | "unchanged";
  readonly skill_id: string;
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly profile_digest?: string;
  readonly runner_names: readonly string[];
  readonly source_type: string;
  readonly registry_url?: string;
  readonly link: RunxLinkResolution;
  readonly record: RegistrySkillVersion;
}

export async function publishSkillMarkdown(
  client: RegistryClient,
  markdown: string,
  options: PublishSkillMarkdownOptions = {},
): Promise<PublishSkillMarkdownResult> {
  const { registryUrl, ...createOptions } = options;
  const result = await client.createSkillVersion(markdown, createOptions);
  const link = runxLinkForVersion(result.record, registryUrl);

  return {
    status: result.created ? "published" : "unchanged",
    skill_id: result.record.skill_id,
    name: result.record.name,
    version: result.record.version,
    digest: result.record.digest,
    profile_digest: result.record.profile_digest,
    runner_names: result.record.runner_names,
    source_type: result.record.source_type,
    registry_url: registryUrl,
    link,
    record: result.record,
  };
}
