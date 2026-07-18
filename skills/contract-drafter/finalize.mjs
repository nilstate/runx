import { readFileSync } from "node:fs";

const inputs = readInputs();

try {
  const draft = asObject(inputs.draft_packet, "draft_packet");
  const sendPlan = unwrapSendPlan(inputs.send_plan);
  const sendDelivery = asObject(inputs.send_delivery, "send_delivery");
  const proposal = asObject(draft.send_proposal, "draft_packet.send_proposal");
  const expectedContentRef = proposal.consumer?.inputs?.content_ref || {};

  const bindingErrors = [];
  if (draft.status !== "draft_ready") bindingErrors.push("draft_packet.status must be draft_ready");
  if (text(expectedContentRef.draft_ref) !== text(draft.draft_ref)) {
    bindingErrors.push("send_proposal content_ref must bind the draft_ref");
  }
  if (text(expectedContentRef.digest) !== text(draft.draft_doc?.content_digest)) {
    bindingErrors.push("send_proposal content_ref digest must bind the draft content digest");
  }
  if (sendDelivery.status !== "sent") bindingErrors.push("send_delivery.status must be sent");
  if (sendDelivery.provider_delivery_performed !== true) {
    bindingErrors.push("send_delivery.provider_delivery_performed must be true");
  }
  if (sendDelivery.readback_verified !== true) {
    bindingErrors.push("send_delivery.readback_verified must be true");
  }
  if (text(sendDelivery.draft_ref) !== text(draft.draft_ref)) {
    bindingErrors.push("send_delivery.draft_ref must bind the draft_ref");
  }
  if (text(sendDelivery.content_digest) !== text(draft.draft_doc?.content_digest)) {
    bindingErrors.push("send_delivery.content_digest must bind the draft content digest");
  }

  if (bindingErrors.length > 0) {
    emit({
      ...draft,
      status: "refused",
      act_decision: "refused",
      act_reason: `refused send_as_binding_failed count=${bindingErrors.length}`,
      validation: {
        ...(draft.validation || {}),
        errors: bindingErrors,
        send_as_composed_in_graph: false,
        provider_delivery_performed: false,
      },
    });
    process.exitCode = 2;
  } else {
    const boundSendPlan = {
      ...sendPlan,
      content: expectedContentRef,
      evidence_refs: [...new Set([...(Array.isArray(sendPlan.evidence_refs) ? sendPlan.evidence_refs : []), text(draft.draft_ref)])],
    };
    const finalized = {
      ...draft,
      status: "draft_ready",
      act_decision: "prepared",
      act_reason: draft.act_reason.replace("status=not_sent", "status=mock_provider_sent"),
      send_proposal: {
        ...proposal,
        status: "mock_provider_sent",
        dispatched_to: {
          skill: "runx/send-as",
          runner: "plan",
          sealed_in_same_graph: true,
        },
        executed_result: {
          schema: "runx.contract_send_execution.v1",
          skill: "runx/send-as",
          runner: "plan",
          result_packet: "runx.send_as.plan.v1",
          send_plan: boundSendPlan,
          content_ref: expectedContentRef,
        },
        provider_action: sendDelivery.provider_actions || boundSendPlan.provider_actions || null,
        provider_delivery_performed: true,
        provider_delivery: sendDelivery,
      },
      send_as_result: {
        schema: "runx.contract_send_as_result.v1",
        skill: "runx/send-as",
        runner: "plan",
        sealed_in_same_graph: true,
        send_plan: boundSendPlan,
        delivery: sendDelivery,
        bound_draft_ref: draft.draft_ref,
        bound_content_digest: draft.draft_doc.content_digest,
        provider_delivery_performed: true,
        readback_verified: true,
      },
      validation: {
        ...(draft.validation || {}),
        errors: [],
        send_as_composed_in_graph: true,
        send_as_result_bound_to_draft: true,
        provider_delivery_performed: true,
        provider_readback_verified: true,
        mock_transport_only: sendDelivery.mock_transport === true,
        live_external_send_performed: sendDelivery.live_external_send_performed === true,
      },
    };
    finalized.draft_doc = {
      ...draft.draft_doc,
      delivery_status: "mock_provider_sent",
    };
    emit(finalized);
  }
} catch (error) {
  emit({
    schema: "runx.contract_draft.v1",
    package: "contract-drafter",
    status: "refused",
    act_decision: "refused",
    act_reason: "refused finalize_error",
    draft_ref: "",
    draft_doc: null,
    deviations: [],
    send_proposal: null,
    send_as_result: null,
    validation: {
      errors: [error instanceof Error ? error.message : String(error)],
      no_draft_emitted: true,
      no_proposal_emitted: true,
      send_as_composed_in_graph: false,
      provider_delivery_performed: false,
    },
  });
  process.exitCode = 2;
}

function unwrapSendPlan(value) {
  const object = asObject(value, "send_plan");
  if (object.send_plan && typeof object.send_plan === "object" && !Array.isArray(object.send_plan)) return object.send_plan;
  return object;
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  const fromEnv = {
    draft_packet: parseEnv("RUNX_INPUT_DRAFT_PACKET"),
    send_plan: parseEnv("RUNX_INPUT_SEND_PLAN"),
    send_delivery: parseEnv("RUNX_INPUT_SEND_DELIVERY"),
  };
  if (Object.values(fromEnv).some((value) => value !== undefined)) return fromEnv;
  return JSON.parse(readFileSync(0, "utf8"));
}

function parseEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
