// reply-router · dogfood runner
// A self-contained runner that exercises the full classify → suppress / route /
// needs_agent branching logic in a single pass. Used for the post-publish
// dogfood run that produces a sealed receipt.
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

function hasSealedReceipt(receipt) {
  return Boolean(
    receipt &&
      receipt.sealed === true &&
      typeof receipt.receipt_id === "string" &&
      receipt.receipt_id.length > 0 &&
      typeof receipt.checksum === "string" &&
      receipt.checksum.startsWith("sha256:")
  );
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
const sealed = hasSealedReceipt(receipt);

// Branch 1: unsealed receipt → needs_agent, no writes, no routing.
if (!sealed) {
  process.stdout.write(JSON.stringify({
    decision: "needs_agent",
    reason: "original_send_receipt is not sealed or is missing a sha256 checksum",
    classification: {
      type: "needs_agent",
      confidence: 1,
      evidence: ["original_send_receipt must be sealed and carry a sha256 checksum"]
    },
    writes_suppression: false,
    emits_routing: false
  }));
  process.exit(0);
}

// Branch 2: unsubscribe intent grounded in reply text + policy → suppress.
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
    },
    writes_suppression: true,
    emits_routing: false
  }));
  process.exit(0);
}

// Branch 3: affirmative non-unsubscribe reply → route via governed send-as.
if (/^(thanks|thank you|sounds good|yes|ok|okay|interested|sure|let'?s do it)\b/i.test(content.trim())) {
  process.stdout.write(JSON.stringify({
    decision: "route",
    classification: {
      type: "reply",
      confidence: 0.92,
      evidence: ["reply content is an affirmative non-unsubscribe response"]
    },
    routing_decision: {
      schema: "runx.reply.routing.v1",
      classification: {
        type: "reply",
        confidence: 0.92,
        evidence: ["reply content is an affirmative non-unsubscribe response"]
      },
      send_target: {
        governed_skill: "send-as",
        lane: "reply-follow-up",
        audience: receipt.send_plan?.audience || { type: "recipient", ref: inbound.received_from },
        channel: receipt.send_plan?.channel || "email",
        original_receipt_id: receipt.receipt_id
      },
      principal: receipt.principal || null,
      next_action: {
        type: "governed_send_as_run",
        sends_now: false,
        requires_preflight: true,
        requires_human_approval: true
      }
    },
    writes_suppression: false,
    emits_routing: true
  }));
  process.exit(0);
}

// Branch 4: ambiguous → needs_agent.
process.stdout.write(JSON.stringify({
  decision: "needs_agent",
  reason: "reply text is ambiguous; no unsubscribe signal and no affirmative routing signal grounded in content",
  classification: {
    type: "ambiguous",
    confidence: 0.54,
    evidence: ["content lacks a clear unsubscribe signal and lacks an affirmative routing signal"]
  },
  writes_suppression: false,
  emits_routing: false
}));
