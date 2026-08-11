import { readFileSync } from "node:fs";

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ""))) {
  const exportName = process.argv[2] || "finalizeDraft";
  const inputs = readInputs();
  const fn = exportName === "finalizeRefusal" ? finalizeRefusal : finalizeDraft;
  process.stdout.write(`${JSON.stringify(fn(inputs))}\n`);
}

export function finalizeDraft(inputs) {
  const draft = requiredRecord(inputs.contract_draft, "contract_draft");
  const sendPlan = requiredRecord(inputs.send_plan, "send_plan");
  const proposal = requiredRecord(draft.send_proposal, "contract_draft.send_proposal");
  const proposalInputs = requiredRecord(requiredRecord(proposal.consumer, "send_proposal.consumer").inputs, "send_proposal.consumer.inputs");
  const draftDoc = requiredRecord(draft.draft_doc, "contract_draft.draft_doc");
  const content = requiredRecord(sendPlan.content, "send_plan.content");
  const gates = requiredRecord(sendPlan.gates, "send_plan.gates");

  requireEqual(draft.schema, "runx.contract_draft.v1", "draft schema must be runx.contract_draft.v1");
  requireEqual(draft.package, "contract-drafter", "draft package must be contract-drafter");
  requireEqual(draft.status, "draft_ready", "draft status must be draft_ready");
  requireEqual(draft.review_status, "requires_review", "draft review_status must be requires_review");
  requireEqual(draft.delivery_status, "not_sent", "draft delivery_status must be not_sent");
  requireEqual(draftDoc.delivery_status, "not_sent", "draft_doc delivery_status must be not_sent");
  requireEqual(proposal.consumer.skill, "runx/send-as", "proposal must target canonical runx/send-as");
  requireEqual(proposal.consumer.runner, "plan", "proposal must target send-as plan");
  requireEqual(proposal.status, "ready_for_send_as", "proposal must be ready_for_send_as");
  requireEqual(proposal.live_external_send_performed, false, "contract-drafter must not send");
  requireEqual(proposal.provider_action, null, "contract-drafter must not select a provider action");

  requireEqual(sendPlan.decision, "ready", "send_plan decision must be ready");
  requireEqual(sendPlan.action_family, "send-as", "send_plan action_family must be send-as");
  requireEqual(requiredRecord(sendPlan.principal, "send_plan.principal").ref, proposalInputs.principal, "send_plan principal must match proposal");
  requireEqual(requiredRecord(sendPlan.audience, "send_plan.audience").ref, requiredRecord(proposalInputs.audience, "proposal audience").ref, "send_plan audience must match proposal");
  requireEqual(content.draft_ref, draft.draft_ref, "send_plan content draft_ref must match draft_ref");
  requireEqual(content.digest, draftDoc.content_digest, "send_plan content digest must match draft digest");
  requireEqual(content.subject_or_title, proposal.subject_or_title, "send_plan subject must match proposal");
  requireEqual(gates.preflight_required, true, "send_plan must require preflight");
  requireEqual(gates.human_approval_required, true, "send_plan must require human approval before provider delivery");

  const checkpoint = requiredRecord(sendPlan.success_checkpoint, "send_plan.success_checkpoint");
  requireEqual(checkpoint.milestone, "provider_delivery_required", "send_plan must leave provider delivery outstanding");
  if (sendPlan.delivery_evidence || sendPlan.provider_receipt || sendPlan.delivery_status === "delivered") {
    throw new Error("send_plan must not claim provider delivery");
  }

  return {
    contract_draft_packet: {
      ...draft,
      send_plan: sendPlan,
      validation: {
        ...requiredRecord(draft.validation, "contract_draft.validation"),
        canonical_send_as_dependency_executed: true,
        canonical_send_as_dependency: "runx/send-as@sha-1f90b9364a3a#plan",
        provider_delivery_outside_contract_drafter: true,
        live_external_send_performed: false,
      },
    },
  };
}

export function finalizeRefusal(inputs) {
  const draft = requiredRecord(inputs.contract_draft, "contract_draft");
  requireEqual(draft.schema, "runx.contract_draft.v1", "refusal schema must be runx.contract_draft.v1");
  requireEqual(draft.package, "contract-drafter", "refusal package must be contract-drafter");
  requireEqual(draft.status, "refused", "refusal status must be refused");
  requireEqual(draft.review_status, "refused", "refusal review_status must be refused");
  requireEqual(draft.delivery_status, "not_sent", "refusal delivery_status must be not_sent");
  if (Object.prototype.hasOwnProperty.call(draft, "draft_doc")) throw new Error("refusal must not emit draft_doc");
  if (Object.prototype.hasOwnProperty.call(draft, "send_proposal")) throw new Error("refusal must not emit send_proposal");
  if (!Array.isArray(draft.deviations) || draft.deviations.length !== 0) throw new Error("refusal must emit empty deviations");
  const validation = requiredRecord(draft.validation, "refusal validation");
  requireEqual(validation.no_draft_emitted, true, "refusal must record no_draft_emitted");
  requireEqual(validation.no_proposal_emitted, true, "refusal must record no_proposal_emitted");
  return { contract_draft_packet: draft };
}

function requiredRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
}

function requireEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return JSON.parse(readFileSync(0, "utf8"));
}
