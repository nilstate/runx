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

function normalize(value) {
  return String(value || "").toLowerCase();
}

const inputs = readInputs();
const inbound = inputs.inbound_reply || {};
const receipt = inputs.original_send_receipt || {};
const policy = inputs.suppression_policy || {};
const projection = inputs.store_projection || {};
const content = String(inbound.content || "");
const signals = (policy.unsubscribe_signals || [])
  .map((signal) => String(signal || "").trim())
  .filter(Boolean)
  .filter((signal) => normalize(content).includes(signal.toLowerCase()));
const sealed = Boolean(receipt.sealed === true && receipt.checksum?.startsWith?.("sha256:"));

if (!sealed) {
  process.stdout.write(JSON.stringify({
    decision: "needs_agent",
    reason: "original_send_receipt is not sealed",
    writes_suppression: false,
    emits_routing: false
  }));
  process.exit(0);
}

if (signals.length > 0) {
  const aggregateId = projection.aggregate_id || inbound.received_from;
  const beforeVersion = Number.isInteger(projection.version) ? projection.version : 0;
  const idempotencyKey = `reply-router:${sha256([
    receipt.receipt_id,
    aggregateId,
    inbound.content
  ].join("|"))}`;
  process.stdout.write(JSON.stringify({
    decision: "suppress",
    classification: {
      type: "unsubscribe",
      confidence: 0.99,
      evidence: signals.map((signal) => `matched signal: ${signal}`)
    },
    suppression_result: {
      aggregate_id: aggregateId,
      idempotency_key: idempotencyKey,
      before_version: beforeVersion,
      after_version: beforeVersion + 1
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
  process.exit(0);
}

process.stdout.write(JSON.stringify({
  decision: "route",
  routing_decision: {
    schema: "runx.reply.routing.v1",
    classification: {
      type: "reply",
      confidence: 0.92,
      evidence: ["reply content is not an unsubscribe request"]
    },
    send_target: {
      governed_skill: "send-as",
      lane: "reply-follow-up",
      audience: receipt.send_plan?.audience || { type: "recipient", ref: inbound.received_from },
      channel: receipt.send_plan?.channel || "email",
      original_receipt_id: receipt.receipt_id
    },
    principal: receipt.principal || null,
    sends_now: false
  }
}));
