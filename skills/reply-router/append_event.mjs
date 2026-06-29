import { createHash } from "node:crypto";

function readInputs() {
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {};
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const inputs = readInputs();
const inbound = inputs.inbound_reply || {};
const receipt = inputs.original_send_receipt || {};
const projection = inputs.store_projection || {};
const classification = inputs.classification || {};
const aggregateId = projection.aggregate_id || inbound.received_from;
const beforeVersion = Number.isInteger(projection.version) ? projection.version : 0;
const idempotencyKey = `reply-router:${sha256([
  receipt.receipt_id,
  aggregateId,
  inbound.content
].join("|"))}`;

const suppressionResult = {
  aggregate_id: aggregateId,
  idempotency_key: idempotencyKey,
  before_version: beforeVersion,
  after_version: beforeVersion + 1
};

process.stdout.write(JSON.stringify({
  suppression_result: suppressionResult,
  recipient_suppression_event: {
    schema: "runx.reply.suppression_event.v1",
    event_type: "recipient_unsubscribed",
    aggregate_id: aggregateId,
    received_at: inbound.received_at,
    source_receipt_id: receipt.receipt_id,
    classification,
    event: {
      recipient_ref: aggregateId,
      status: "suppressed",
      reason: "unsubscribe reply",
      evidence: classification.evidence || []
    }
  },
  data_store_call: {
    registry_ref: "registry:runx/data-store@0.1.2",
    operation: "append_event",
    store_id: projection.store_id || "runx.reply-router.suppression.v1",
    aggregate_id: aggregateId,
    expected_version: beforeVersion,
    idempotency_key: idempotencyKey
  }
}));
