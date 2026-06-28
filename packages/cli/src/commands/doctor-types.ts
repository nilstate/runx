import {
  canonicalJsonStringify,
  sha256Prefixed,
  type DoctorDiagnosticContract,
  type DoctorRepairContract,
  type DoctorReportContract,
} from "@runxhq/contracts";

export type DoctorRepair = DoctorRepairContract;
export type DoctorDiagnostic = DoctorDiagnosticContract;
export type DoctorReport = DoctorReportContract;

export function createDoctorDiagnostic(
  diagnostic: Omit<DoctorDiagnostic, "instance_id">,
): DoctorDiagnostic {
  // Canonical, order-independent identity: recursively key-sorted JSON of the
  // typed {id, target, location, evidence} material under runx.stable-json.v1.
  // The Rust doctor mirrors this byte-for-byte via canonical_stable_json over
  // the same JsonObject material, so both languages produce identical ids.
  // `evidence` is omitted when absent to match Rust's skip_serializing_if(None).
  const material: Record<string, unknown> = {
    id: diagnostic.id,
    target: diagnostic.target,
    location: diagnostic.location,
  };
  if (diagnostic.evidence !== undefined) {
    material.evidence = diagnostic.evidence;
  }
  return {
    ...diagnostic,
    instance_id: sha256Prefixed(canonicalJsonStringify(material)),
  };
}
