import { readFileSync } from "node:fs";
import { classify } from "./classify.mjs";
import { appendSuppressionEvent } from "./append_event.mjs";
import { emitRoutingDecision } from "./emit_route.mjs";

const raw = process.env.RUNX_INPUTS_PATH
  ? readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
  : process.env.RUNX_INPUTS_JSON || "{}";
const inputs = JSON.parse(raw);

const classification = await classify(
  inputs.inbound_reply,
  inputs.original_send_receipt,
  inputs.suppression_policy,
);

let suppression_result = null;
let routing_decision = null;
let escalation_lane = null;

if (classification.route === "suppress") {
  suppression_result = await appendSuppressionEvent(
    inputs.inbound_reply,
    inputs.original_send_receipt,
    inputs.store_projection,
    classification,
  );
} else if (classification.route === "route") {
  routing_decision = emitRoutingDecision(
    inputs.inbound_reply,
    inputs.original_send_receipt,
    classification,
  );
} else {
  escalation_lane = {
    reason: classification.reason,
    requires: "human_approval",
    lane: "compliance.reply-router-review",
  };
}

console.log(JSON.stringify({
  classification_type: classification.type,
  classification: {
    type: classification.type,
    confidence: classification.confidence,
    evidence: classification.evidence,
  },
  suppression_result,
  routing_decision,
  escalation_lane,
  route: classification.route,
  reason: classification.reason,
}, null, 2));
