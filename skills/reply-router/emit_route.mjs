function readInputs() {
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {};
}

const inputs = readInputs();
const inbound = inputs.inbound_reply || {};
const receipt = inputs.original_send_receipt || {};
const classification = inputs.classification || {};
const sendPlan = receipt.send_plan || {};

process.stdout.write(JSON.stringify({
  routing_decision: {
    schema: "runx.reply.routing.v1",
    classification,
    send_target: {
      governed_skill: "send-as",
      lane: "reply-follow-up",
      audience: sendPlan.audience || { type: "recipient", ref: inbound.received_from },
      channel: sendPlan.channel || "email",
      original_receipt_id: receipt.receipt_id
    },
    principal: receipt.principal || sendPlan.principal || null,
    next_action: {
      type: "governed_send_as_run",
      sends_now: false,
      requires_preflight: true,
      requires_human_approval: true
    }
  }
}));
