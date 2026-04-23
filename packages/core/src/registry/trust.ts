import type { RegistrySkillVersion } from "./store.js";

export type TrustSignalStatus = "verified" | "declared" | "not_declared" | "placeholder";

export interface TrustSignal {
  readonly id: string;
  readonly label: string;
  readonly status: TrustSignalStatus;
  readonly value: string;
}

export function deriveTrustSignals(version: RegistrySkillVersion): readonly TrustSignal[] {
  return [
    {
      id: "digest",
      label: "Immutable digest",
      status: "verified",
      value: `sha256:${version.digest}`,
    },
    {
      id: "source_type",
      label: "Execution source",
      status: "declared",
      value: version.source_type,
    },
    {
      id: "publisher",
      label: "Publisher identity",
      // runx-owned skills are official; everything else stays at placeholder
      // until a publisher identity is formally attested.
      status:
        version.owner === "runx" || version.publisher.type !== "placeholder"
          ? "verified"
          : "placeholder",
      value: version.publisher.id,
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
