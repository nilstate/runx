import type { RegistryAttestation, RegistryPublisher, RegistrySkillVersion, RegistrySourceMetadata, RegistryTrustTier } from "./store.js";

export type TrustSignalStatus = "verified" | "declared" | "not_declared" | "placeholder";

export interface TrustSignal {
  readonly id: string;
  readonly label: string;
  readonly status: TrustSignalStatus;
  readonly value: string;
}

export function defaultRegistryPublisher(owner: string): RegistryPublisher {
  return owner === "runx"
    ? { kind: "organization", id: owner, handle: owner }
    : { kind: "publisher", id: owner, handle: owner };
}

export function deriveRegistryTrustTier(options: {
  readonly owner: string;
  readonly trust_tier?: RegistryTrustTier;
}): RegistryTrustTier {
  if (options.trust_tier === "first_party" || options.trust_tier === "verified" || options.trust_tier === "community") {
    return options.trust_tier;
  }
  if (options.owner === "runx") {
    return "first_party";
  }
  return "community";
}

export function buildSourceAttestations(
  sourceMetadata: RegistrySourceMetadata | undefined,
  issuedAt: string,
): readonly RegistryAttestation[] {
  if (!sourceMetadata) {
    return [];
  }
  return [
    {
      kind: "source",
      id: `${sourceMetadata.provider}_source`,
      status: "verified",
      summary: `${sourceMetadata.provider}:${sourceMetadata.repo}@${sourceMetadata.sha}`,
      source: sourceMetadata.repo_url,
      issued_at: issuedAt,
      metadata: {
        repo: sourceMetadata.repo,
        ref: sourceMetadata.ref,
        sha: sourceMetadata.sha,
        event: sourceMetadata.event,
        skill_path: sourceMetadata.skill_path,
        profile_path: sourceMetadata.profile_path,
      },
    },
  ];
}

export function buildPublisherAttestations(
  publisher: RegistryPublisher,
  trustTier: RegistryTrustTier,
  issuedAt: string,
): readonly RegistryAttestation[] {
  const label = publisher.display_name ?? publisher.handle ?? publisher.id;
  return [
    {
      kind: "publisher",
      id: `publisher:${publisher.id}`,
      status: trustTier === "community" ? "declared" : "verified",
      summary: label,
      issued_at: issuedAt,
      metadata: {
        publisher_id: publisher.id,
        publisher_kind: publisher.kind,
        publisher_handle: publisher.handle,
        publisher_display_name: publisher.display_name,
        trust_tier: trustTier,
      },
    },
  ];
}

export function mergeRegistryAttestations(
  ...groups: readonly (readonly RegistryAttestation[] | undefined)[]
): readonly RegistryAttestation[] | undefined {
  const merged = new Map<string, RegistryAttestation>();
  for (const group of groups) {
    if (!group) {
      continue;
    }
    for (const attestation of group) {
      merged.set(`${attestation.kind}:${attestation.id}`, attestation);
    }
  }
  return merged.size > 0 ? Array.from(merged.values()) : undefined;
}

export function deriveTrustSignals(version: RegistrySkillVersion): readonly TrustSignal[] {
  const trustTier = deriveRegistryTrustTier(version);
  const provenance = sourceProvenance(version.source_metadata, version.attestations);
  const publisherAttestation = version.attestations?.find((attestation) => attestation.kind === "publisher");
  const publisherLabel = version.publisher.display_name ?? version.publisher.handle ?? version.publisher.id;
  return [
    {
      id: "digest",
      label: "Immutable digest",
      status: "verified",
      value: `sha256:${version.digest}`,
    },
    {
      id: "trust_tier",
      label: "Trust tier",
      status: trustTier === "community" ? "declared" : "verified",
      value: trustTier,
    },
    {
      id: "publisher",
      label: "Publisher identity",
      status: publisherAttestation?.status ?? "not_declared",
      value: publisherLabel,
    },
    {
      id: "provenance",
      label: "Source provenance",
      status: provenance ? "verified" : "not_declared",
      value: provenance ?? "no source attestation",
    },
    {
      id: "source_type",
      label: "Execution source",
      status: "declared",
      value: version.source_type,
    },
    {
      id: "scopes",
      label: "Required scopes",
      status: version.required_scopes.length > 0 ? "declared" : "not_declared",
      value: version.required_scopes.length > 0 ? version.required_scopes.join(", ") : "none declared",
    },
    {
      id: "runtime",
      label: "Runtime requirements",
      status: version.runtime ? "declared" : "not_declared",
      value: version.runtime ? "declared in skill metadata" : "none declared",
    },
    {
      id: "runner_metadata",
      label: "Materialized binding",
      status: version.profile_digest ? "verified" : "not_declared",
      value: version.profile_digest
        ? `${version.runner_names.length} runner(s), binding sha256:${version.profile_digest}`
        : "portable agent runner",
    },
  ];
}

function sourceProvenance(
  sourceMetadata: RegistrySourceMetadata | undefined,
  attestations: readonly RegistryAttestation[] | undefined,
): string | undefined {
  if (sourceMetadata) {
    return `${sourceMetadata.provider}:${sourceMetadata.repo}@${sourceMetadata.sha}`;
  }
  const sourceAttestation = attestations?.find((attestation) => attestation.kind === "source");
  return sourceAttestation?.summary;
}
