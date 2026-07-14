import { createHash } from "node:crypto";

function readInputs() {
  return JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
}

function fail(id, message) {
  process.stderr.write(`${id}: ${message}\n`);
  process.exit(78);
}

const {
  admission_check: admissionCheck,
  approval_decision: approvalDecision,
} = readInputs();

if (!admissionCheck || admissionCheck.decision !== "ready_for_approval") {
  fail(
    "runx.overlay.admission.invalid",
    "A successful immutable admission check is required before finalization.",
  );
}
if (!approvalDecision || approvalDecision.approved !== true) {
  fail(
    "runx.overlay.approval.missing",
    "The native browser-session approval gate must be approved before finalization.",
  );
}

const admissionDigest = `sha256:${createHash("sha256")
  .update(JSON.stringify(admissionCheck))
  .digest("hex")}`;
const governanceDecision = {
  schema: "runx.skill_overlay.v1",
  objective: admissionCheck.objective,
  wraps: admissionCheck.wraps,
  resolved_digest: admissionCheck.resolved_digest,
  governance: admissionCheck.governance,
  approval: {
    gate_id: "overlay-open-skill-1.browser-session.approval",
    approved: true,
  },
  admission_digest: admissionDigest,
  decision: "ready",
  diagnostics: [],
};

process.stdout.write(`${JSON.stringify({ governance_decision: governanceDecision })}\n`);
