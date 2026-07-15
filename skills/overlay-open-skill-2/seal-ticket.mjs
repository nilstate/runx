import { createHash } from "node:crypto";

const EXPECTED_ADMISSION_SCHEMA =
  "runx.skill_overlay.skill_search_admission.v1";
const GATE_ID = "overlay-open-skill-2.skill-search.approval";
const GATE_REASON =
  "Approve the exact owner, query tokens, result cap, and argv before issuing a receipt-bound single-search authorization.";

function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, deepSort(value[key])]),
  );
}

function approvalIdempotencyKey(inputs) {
  const summary = deepSort({
    objective: inputs.objective,
    resolved_digest: inputs.resolved_digest,
    query: inputs.query,
    owner: inputs.owner,
    operation: inputs.operation,
    allow_install: inputs.allow_install,
    max_results: inputs.max_results,
    admission: inputs.admission,
  });
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ id: GATE_ID, reason: GATE_REASON, summary }))
    .digest("hex")}`;
}

function readInputs() {
  return JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
}

function fail(id, message) {
  process.stdout.write(
    `${JSON.stringify({
      search_act: {
        schema: "runx.skill_overlay.skill_search_act.v1",
        decision: "refused",
        diagnostics: [{ id, severity: "error", message }],
      },
    })}\n`,
  );
  process.stderr.write(`${id}: ${message}\n`);
  process.exitCode = 78;
}

function main() {
  const inputs = readInputs();
  const admission = inputs.admission;
  const approval = inputs.approval;
  if (
    !admission ||
    admission.schema !== EXPECTED_ADMISSION_SCHEMA ||
    admission.decision !== "ready_for_approval"
  ) {
    fail(
      "runx.overlay.admission.invalid",
      "A ready, receipt-bound search admission is required before authorization.",
    );
    return;
  }
  if (!approval || approval.approved !== true) {
    fail(
      "runx.overlay.approval.required",
      "The native operator approval gate did not approve this exact search.",
    );
    return;
  }
  const expectedApprovalKey = approvalIdempotencyKey(inputs);
  if (
    approval.gate_id !== GATE_ID ||
    approval.status !== "approved" ||
    approval.idempotency_key !== expectedApprovalKey
  ) {
    fail(
      "runx.overlay.approval.binding.invalid",
      "The approval decision is not bound to the expected gate and decision key.",
    );
    return;
  }

  const ticketBody = {
    schema: "runx.skill_overlay.skill_search_act.v1",
    decision: "single_search_authority_issued",
    objective: admission.objective,
    wraps: admission.wraps,
    consumed_attenuation: admission.attenuation,
    approval: {
      gate_id: GATE_ID,
      approved: true,
      status: approval.status,
      actor: approval.actor || null,
      decision_idempotency_key: approval.idempotency_key,
    },
    idempotency_key: admission.idempotency_key,
    denied_capabilities: admission.denied_capabilities,
    closure: {
      authority: "single_effect",
      max_effects: 1,
      execution_performed: false,
      consumption_requirement: "host_idempotency_registry",
      shell_interpreter: "denied",
      required_readback: "exit_status_and_redacted_bounded_results",
      required_effect_receipt: true,
      installation_requires_separate_governance: true,
    },
    diagnostics: [],
  };
  const ticketDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(ticketBody))
    .digest("hex")}`;
  process.stdout.write(
    `${JSON.stringify({
      search_act: { ...ticketBody, ticket_digest: ticketDigest },
    })}\n`,
  );
}

main();
