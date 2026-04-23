import { createHash } from "node:crypto";

import type {
  DoctorDiagnosticContract,
  DoctorRepairContract,
  DoctorReportContract,
} from "@runxhq/contracts";

export type DoctorRepair = DoctorRepairContract;
export type DoctorDiagnostic = DoctorDiagnosticContract;
export type DoctorReport = DoctorReportContract;

export function createDoctorDiagnostic(
  diagnostic: Omit<DoctorDiagnostic, "instance_id">,
): DoctorDiagnostic {
  return {
    ...diagnostic,
    instance_id: `sha256:${createHash("sha256").update(JSON.stringify({
      id: diagnostic.id,
      target: diagnostic.target,
      location: diagnostic.location,
      evidence: diagnostic.evidence,
    })).digest("hex")}`,
  };
}
