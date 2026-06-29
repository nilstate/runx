import fs from "node:fs";
import crypto from "node:crypto";

const inputs = readInputs();

const inboundReply = object(inputs.inbound_reply, "inbound_reply");
const originalReceipt = object(inputs.original_send_receipt, "original_send_receipt");
const suppressionPolicy = object(inputs.suppression_policy, "suppression_policy");
const dataSourceRef = requiredText(inputs.data_source_ref, "data_source_ref");
const storeId = requiredText(inputs.store_id, "store_id");

const content = requiredText(inboundReply.content, "inbound_reply.content");
const receivedFrom = requiredText(inboundReply.received_from, "inbound_reply.received_from");
const receivedAt = requiredText(inboundReply.received_at, "inbound_reply.received_at");
const receiptId = text(originalReceipt.receipt_id);
const checksum = text(originalReceipt.checksum);
const principal = text(originalReceipt.principal) || "unknown-principal";
const sendPlan = objectOrNull(originalReceipt.send_plan) || {};
const threshold = finiteNumber(suppressionPolicy.confidence_threshold)
  ? Number(suppressionPolicy.confidence_threshold)
  : 0.8;
const unsubscribeSignals = Array.isArray(suppressionPolicy.unsubscribe_signals)
  ? suppressionPolicy.unsubscribe_signals.map(text).filter(Boolean)
  : [];

const stopReasons = [];
if (originalReceipt.sealed !== true) stopReasons.push("original_send_receipt is not sealed");
if (!receiptId) stopReasons.push("original_send_receipt.receipt_id is required");
if (!checksum) stopReasons.push("original_send_receipt.checksum is required");
if (!unsubscribeSignals.length) stopReasons.push("suppression_policy.unsubscribe_signals must not be empty");

const normalized = normalize(content);
const matchedSignals = unsubscribeSignals.filter((signal) => normalized.includes(normalize(signal)));

if (stopReasons.length) {
  emit(buildStop(stopReasons, "unsealed_or_malformed_receipt"));
  process.exit(2);
}

const classification = classifyReply(normalized, matchedSignals, threshold);

if (classification.confidence < threshold || classification.type === "ambiguous") {
  emit(buildStop([`ambiguous or low-confidence reply: ${classification.type} at ${classification.confidence}`], "ambiguous_or_low_confidence", classification));
  process.exit(2);
}

if (classification.type === "unsubscribe") {
  const expectedVersion = finiteNumber(sendPlan.recipient_state_version)
    ? Number(sendPlan.recipient_state_version)
    : 0;
  const idempotencyKey = stableKey([receivedFrom, receiptId, "unsubscribe"]);
  const event = {
    type: "reply_router.suppression_recorded",
    recipient: receivedFrom,
    classification,
    policy_signal_refs: matchedSignals,
    original_send_receipt_id: receiptId,
    received_at: receivedAt,
    principal,
    created_at: receivedAt,
  };

  emit({
    classification,
    suppression_result: {
      dependency: "registry:runx/data-store@0.1.2",
      sequence: ["read_projection", "classify", "append_event"],
      read_projection: {
        data_source_ref: dataSourceRef,
        store_id: storeId,
        resource: "reply_suppressions",
        aggregate_id: receivedFrom,
      },
      append_event: {
        data_source_ref: dataSourceRef,
        store_id: storeId,
        resource: "reply_suppressions",
        aggregate_id: receivedFrom,
        expected_version: expectedVersion,
        idempotency_key: idempotencyKey,
        event,
      },
      aggregate_id: receivedFrom,
      idempotency_key: idempotencyKey,
      before_version: expectedVersion,
      after_version: expectedVersion + 1,
    },
    routing_decision: null,
    escalation: {
      required: false,
      lane: null,
      no_send_performed: true,
      no_routing_alongside_unsubscribe: true,
    },
    evidence: baseEvidence({
      matchedSignals,
      idempotencyKey,
      beforeVersion: expectedVersion,
      afterVersion: expectedVersion + 1,
      writePrepared: true,
      sendTarget: null,
      reason: "unsubscribe-class reply wrote suppression packet and emitted no routing decision",
    }),
  });
} else {
  const sendTarget = boundedTargetFor(classification.type, sendPlan.allowed_targets || {});
  emit({
    classification,
    suppression_result: null,
    routing_decision: {
      schema: "runx.reply.routing.v1",
      classification,
      send_target: sendTarget,
      principal,
      original_send_receipt_id: receiptId,
      dispatch: {
        form: "named_governed_send_as_run",
        run_name: "reply-router-followup",
        sends_now: false,
      },
    },
    escalation: {
      required: false,
      lane: null,
      no_send_performed: true,
      downstream_send_requires_separate_governed_run: true,
    },
    evidence: baseEvidence({
      matchedSignals,
      idempotencyKey: null,
      beforeVersion: null,
      afterVersion: null,
      writePrepared: false,
      sendTarget,
      reason: "non-unsubscribe reply emitted bounded routing decision only",
    }),
  });
}

function classifyReply(textValue, matched, thresholdValue) {
  if (matched.length) {
    return {
      type: "unsubscribe",
      confidence: Math.max(0.95, thresholdValue),
      evidence: matched.map((signal) => `matched suppression policy signal '${signal}'`),
    };
  }
  const routePatterns = [
    ["out_of_office", /(out of office|ooo|away until|on vacation)/, "out-of-office language"],
    ["wrong_person", /(wrong person|not the right person|contact .* instead|try .+@)/, "wrong-person routing language"],
    ["interested", /(interested|tell me more|book|schedule|sounds good|yes[, ]|let.?s talk)/, "positive interest language"],
    ["objection", /(too expensive|not now|no budget|already use|concern|problem|maybe later)/, "objection language"],
  ];
  for (const [type, regex, evidence] of routePatterns) {
    if (regex.test(textValue)) {
      return { type, confidence: 0.88, evidence: [evidence] };
    }
  }
  return { type: "ambiguous", confidence: 0.42, evidence: ["no policy-grounded classification signal found"] };
}

function boundedTargetFor(type, allowedTargets) {
  const explicit = text(allowedTargets[type]);
  if (explicit) return explicit;
  return `runx:send-target:${type.replace(/_/g, "-")}`;
}

function buildStop(reasons, reasonCode, classification = null) {
  return {
    classification: classification || {
      type: "ambiguous",
      confidence: 0,
      evidence: reasons,
    },
    suppression_result: null,
    routing_decision: null,
    escalation: {
      required: true,
      lane: "human_approval",
      reason_code: reasonCode,
      reason: reasons.join("; "),
      no_suppression_write: true,
      no_routing_decision: true,
      no_send_performed: true,
    },
    evidence: baseEvidence({
      matchedSignals,
      idempotencyKey: null,
      beforeVersion: null,
      afterVersion: null,
      writePrepared: false,
      sendTarget: null,
      reason: reasons.join("; "),
    }),
  };
}

function baseEvidence(extra) {
  return {
    package: "reply-router",
    inbound_digest: digest(content),
    received_from: receivedFrom,
    received_at: receivedAt,
    original_send_receipt_id: receiptId || null,
    original_send_checksum: checksum || null,
    suppression_policy_signals: unsubscribeSignals,
    matched_unsubscribe_signals: extra.matchedSignals,
    aggregate_id: receivedFrom,
    idempotency_key: extra.idempotencyKey,
    before_version: extra.beforeVersion,
    after_version: extra.afterVersion,
    write_prepared: extra.writePrepared,
    routing_send_target: extra.sendTarget,
    sends_now: false,
    no_attenuation_request: true,
    no_operational_proposal: true,
    rules_applied: [
      "refuse to classify unsealed original send receipts",
      "suppress only when unsubscribe intent is grounded in suppression_policy",
      "never route a send alongside unsubscribe",
      "route non-unsubscribe replies only by naming a separate governed send-as run",
      "stop ambiguous or low-confidence replies before write",
    ],
    summary: extra.reason,
  };
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  const envInputs = {
    inbound_reply: parseInputValue(process.env.RUNX_INPUT_INBOUND_REPLY),
    original_send_receipt: parseInputValue(process.env.RUNX_INPUT_ORIGINAL_SEND_RECEIPT),
    suppression_policy: parseInputValue(process.env.RUNX_INPUT_SUPPRESSION_POLICY),
    data_source_ref: parseInputValue(process.env.RUNX_INPUT_DATA_SOURCE_REF),
    store_id: parseInputValue(process.env.RUNX_INPUT_STORE_ID),
  };
  if (Object.values(envInputs).some((value) => value !== undefined)) return envInputs;
  return JSON.parse(fs.readFileSync(0, "utf8"));
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredText(value, label) {
  const out = text(value);
  if (!out) fail(`${label} is required`);
  return out;
}

function finiteNumber(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function stableKey(parts) {
  return parts.map((part) => String(part).replace(/[^a-zA-Z0-9_.:-]/g, "_")).join(":");
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
  process.exit(2);
}
