import crypto from "node:crypto";
import fs from "node:fs";

const inputs = readInputs();
const inboundReply = objectValue(inputs.inbound_reply);
const originalReceipt = objectValue(inputs.original_send_receipt);
const suppressionPolicy = objectValue(inputs.suppression_policy);

const content = stringValue(inboundReply.content);
const normalizedContent = (content || "").toLowerCase();
const sender = stringValue(inboundReply.received_from);
const receivedAt = stringValue(inboundReply.received_at);
const sendPlan = objectValue(originalReceipt.send_plan);
const principal = stringValue(originalReceipt.principal) || stringValue(sendPlan.principal);
const recipient = stringValue(sendPlan.recipient) || sender;
const receiptId = stringValue(originalReceipt.receipt_id);
const checksum = stringValue(originalReceipt.checksum);
const threshold = numberValue(suppressionPolicy.confidence_threshold, 0.8);
const signals = arrayValue(suppressionPolicy.unsubscribe_signals)
  .map((entry) => String(entry).trim().toLowerCase())
  .filter(Boolean);
const priorProjection = objectValue(suppressionPolicy.prior_projection);
const beforeVersion = numberValue(priorProjection.version, 0);
const dataSourceRef = stringValue(suppressionPolicy.data_source_ref) || "registry:runx/data-store@0.1.2";
const resource = stringValue(suppressionPolicy.resource) || "suppression_events";
const storeId = stringValue(suppressionPolicy.store_id) || "reply-router-suppression-v1";

const packet = routeReply();
process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);

function routeReply() {
  const base = {
    schema: "runx.reply.router.v1",
    package: "reply-router",
    version: "0.1.0",
    input_refs: {
      inbound_from: sender,
      received_at: receivedAt,
      original_receipt_id: receiptId,
      original_receipt_checksum: checksum,
      principal,
    },
  };

  if (!content || !sender || !recipient) {
    return escalate(base, "missing_required_reply_context", [
      "inbound_reply.content, inbound_reply.received_from, and send_plan.recipient or received_from are required",
    ]);
  }

  if (!isSealedReceipt(originalReceipt)) {
    return escalate(base, "unsealed_original_send_receipt", [
      "original_send_receipt.state is not sealed and original_send_receipt.sealed is not true",
    ]);
  }

  const unsubscribeEvidence = signals.filter((signal) => normalizedContent.includes(signal));
  if (unsubscribeEvidence.length > 0) {
    const confidence = Math.max(threshold, 0.99);
    const aggregateId = `recipient:${recipient.toLowerCase()}`;
    const idempotencyKey = hash([
      "reply-router",
      "unsubscribe",
      aggregateId,
      receiptId,
      checksum,
      content,
    ].join("\n"));
    const event = {
      type: "reply.unsubscribe_suppressed",
      payload: {
        recipient,
        received_from: sender,
        received_at: receivedAt,
        matched_signals: unsubscribeEvidence,
        original_receipt_id: receiptId,
        original_receipt_checksum: checksum,
        principal,
      },
    };
    return {
      ...base,
      decision: "suppress",
      classification: {
        type: "unsubscribe",
        confidence,
        evidence: unsubscribeEvidence.map((signal) => `matched policy signal: ${signal}`),
      },
      suppression_result: {
        schema: "runx.data.operation_result.v1",
        operation: "append_event",
        data_source_ref: dataSourceRef,
        store_id: storeId,
        resource,
        aggregate_id: aggregateId,
        expected_version: beforeVersion,
        before_version: beforeVersion,
        after_version: beforeVersion + 1,
        idempotency_key: idempotencyKey,
        event,
        status: "append_event_ready",
        contract_ref: "registry:runx/data-store@0.1.2",
      },
      routing_decision: null,
      escalation_lane: null,
      summary: `Suppressed ${recipient} because the reply contained ${unsubscribeEvidence.join(", ")}; no send route was emitted.`,
    };
  }

  const routed = classifyRoutable(normalizedContent);
  if (!routed) {
    return escalate(base, "ambiguous_reply", [
      "reply text did not contain unsubscribe intent or enough grounded routing evidence",
    ]);
  }

  return {
    ...base,
    decision: "route",
    classification: {
      type: routed.type,
      confidence: routed.confidence,
      evidence: routed.evidence,
    },
    suppression_result: null,
    routing_decision: {
      schema: "runx.reply.routing.v1",
      classification: {
        type: routed.type,
        confidence: routed.confidence,
      },
      send_target: {
        name: routed.sendTarget,
        bounded: true,
        reason: routed.reason,
      },
      principal,
      dispatch: {
        kind: "named_governed_run",
        runner: "send-as",
        status: "not_sent",
        note: "reply-router never sends; a downstream governed send-as run must honor this decision later.",
      },
    },
    escalation_lane: null,
    summary: `Routed ${recipient} as ${routed.type}; no suppression write was emitted and no send was performed.`,
  };
}

function classifyRoutable(text) {
  if (/\b(interested|tell me more|send details|book|schedule|demo)\b/i.test(text)) {
    return {
      type: "interested",
      confidence: 0.91,
      evidence: ["reply contains positive buying or scheduling intent"],
      sendTarget: "send-as.reply.interested",
      reason: "respond with the bounded interested-reply target",
    };
  }
  if (/\b(price|cost|expensive|budget|not now|later)\b/i.test(text)) {
    return {
      type: "objection",
      confidence: 0.86,
      evidence: ["reply contains budget or timing objection evidence"],
      sendTarget: "send-as.reply.objection",
      reason: "respond with the bounded objection-handling target",
    };
  }
  if (/\b(out of office|ooo|vacation|away until|back on)\b/i.test(text)) {
    return {
      type: "out_of_office",
      confidence: 0.93,
      evidence: ["reply contains out-of-office evidence"],
      sendTarget: "send-as.reply.defer",
      reason: "schedule a deferred governed send-as follow-up",
    };
  }
  if (/\b(wrong person|not me|contact someone else|try )\b/i.test(text)) {
    return {
      type: "wrong_person",
      confidence: 0.9,
      evidence: ["reply says the recipient is not the right contact"],
      sendTarget: "send-as.reply.redirect_request",
      reason: "ask for the appropriate contact without continuing the original sequence",
    };
  }
  return null;
}

function escalate(base, reasonCode, evidence) {
  return {
    ...base,
    decision: "needs_agent",
    classification: {
      type: "needs_agent",
      confidence: 0,
      evidence,
    },
    suppression_result: null,
    routing_decision: null,
    escalation_lane: {
      type: "human_approval",
      reason_code: reasonCode,
      caller_answers_required: ["classification.review", "original_send_receipt.review"],
    },
    summary: `Stopped for ${reasonCode}; no suppression write and no routing decision were emitted.`,
  };
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function isSealedReceipt(receipt) {
  return receipt.sealed === true || stringValue(receipt.state) === "sealed";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hash(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}
