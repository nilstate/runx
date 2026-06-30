import fs from "node:fs";

const inputs = readInputs();

try {
  const packet = decide(inputs);
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(64);
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function decide(raw) {
  const aggregateId = requireString(raw.aggregate_id, "aggregate_id");
  const expectedVersion = requireNumber(raw.expected_version, "expected_version");
  const idempotencyKey = requireString(raw.idempotency_key, "idempotency_key");
  const inbound = requireObject(raw.inbound_reply, "inbound_reply");
  const receipt = requireObject(raw.original_send_receipt, "original_send_receipt");
  const policy = requireObject(raw.suppression_policy, "suppression_policy");
  const projection = raw.recipient_projection && typeof raw.recipient_projection === "object"
    ? raw.recipient_projection
    : null;

  const content = requireString(inbound.content, "inbound_reply.content");
  const receivedFrom = requireString(inbound.received_from, "inbound_reply.received_from");
  const receivedAt = requireString(inbound.received_at, "inbound_reply.received_at");
  const receiptId = requireString(receipt.receipt_id, "original_send_receipt.receipt_id");
  const checksum = requireString(receipt.checksum, "original_send_receipt.checksum");
  const principal = requireString(receipt.principal, "original_send_receipt.principal");
  const sendPlan = requireObject(receipt.send_plan, "original_send_receipt.send_plan");
  const signals = requireStringArray(policy.unsubscribe_signals, "suppression_policy.unsubscribe_signals");
  const threshold = requireNumber(policy.confidence_threshold, "suppression_policy.confidence_threshold");

  if (receipt.sealed !== true) {
    throw new Error("original_send_receipt must be sealed before reply routing can classify or suppress");
  }

  const projectionVersion = projection && Number.isFinite(Number(projection.version))
    ? Number(projection.version)
    : expectedVersion;

  if (projectionVersion !== expectedVersion) {
    throw new Error(`recipient projection version ${projectionVersion} does not match expected_version ${expectedVersion}`);
  }

  const normalized = normalize(content);
  const matchedUnsubscribeSignals = signals.filter((signal) => normalized.includes(normalize(signal)));

  if (matchedUnsubscribeSignals.length > 0) {
    const confidence = 0.99;
    return suppressionPacket({
      aggregateId,
      expectedVersion,
      idempotencyKey,
      receivedFrom,
      receivedAt,
      receiptId,
      checksum,
      matchedSignals: matchedUnsubscribeSignals,
      confidence,
      content,
    });
  }

  const route = routeFor(normalized);
  if (!route || route.confidence < threshold) {
    throw new Error("ambiguous reply needs human approval before routing or suppression");
  }

  return routingPacket({
    aggregateId,
    receivedFrom,
    receivedAt,
    receiptId,
    checksum,
    principal,
    sendPlan,
    route,
    content,
  });
}

function suppressionPacket({ aggregateId, expectedVersion, idempotencyKey, receivedFrom, receivedAt, receiptId, checksum, matchedSignals, confidence, content }) {
  const classification = {
    type: "unsubscribe",
    confidence,
    evidence: {
      matched_unsubscribe_signals: matchedSignals,
      content_excerpt: excerpt(content),
      original_receipt_id: receiptId,
      checksum,
      received_from: receivedFrom,
      received_at: receivedAt,
    },
  };

  const suppressionEvent = {
    event_type: "reply_router.suppression_recorded",
    aggregate_id: aggregateId,
    recipient: receivedFrom,
    reason: "unsubscribe intent matched policy signal",
    evidence: {
      classification_type: classification.type,
      confidence,
      matched_unsubscribe_signals: matchedSignals,
      original_receipt_id: receiptId,
      received_at: receivedAt,
    },
  };

  return {
    classification_type: classification.type,
    classification,
    suppression_event: suppressionEvent,
    suppression_result: {
      aggregate_id: aggregateId,
      idempotency_key: idempotencyKey,
      before_version: expectedVersion,
      after_version: expectedVersion + 1,
    },
    routing_decision: null,
    escalation_lane: null,
    append_event_count: 1,
  };
}

function routingPacket({ aggregateId, receivedFrom, receivedAt, receiptId, checksum, principal, sendPlan, route, content }) {
  const classification = {
    type: route.type,
    confidence: route.confidence,
    evidence: {
      matched_routing_signals: route.signals,
      content_excerpt: excerpt(content),
      original_receipt_id: receiptId,
      checksum,
      received_from: receivedFrom,
      received_at: receivedAt,
    },
  };

  const routingDecision = {
    schema: "runx.reply.routing.v1",
    classification,
    send_target: {
      run: "send-as",
      dispatch_ref: route.dispatch_ref,
      channel: sendPlan.channel || "email",
      audience: {
        type: "recipient",
        ref: receivedFrom,
      },
      content_ref: route.content_ref,
      human_approval_required: true,
      bounded_to_original_receipt: receiptId,
    },
    principal,
  };

  return {
    classification_type: classification.type,
    classification,
    suppression_event: null,
    suppression_result: null,
    routing_decision: routingDecision,
    escalation_lane: route.escalation_lane,
    append_event_count: 0,
  };
}

function routeFor(text) {
  const routes = [
    {
      type: "interested",
      signals: ["interested", "tell me more", "book", "schedule", "demo"],
      confidence: 0.91,
      dispatch_ref: "send-as:reply-router:interested-follow-up",
      content_ref: "reply-router:interested-follow-up",
      escalation_lane: "sales_follow_up_review",
    },
    {
      type: "objection",
      signals: ["too expensive", "not now", "concern", "objection", "budget"],
      confidence: 0.86,
      dispatch_ref: "send-as:reply-router:objection-response",
      content_ref: "reply-router:objection-response",
      escalation_lane: "objection_review",
    },
    {
      type: "out_of_office",
      signals: ["out of office", "ooo", "away until", "on leave"],
      confidence: 0.9,
      dispatch_ref: "send-as:reply-router:defer-follow-up",
      content_ref: "reply-router:defer-follow-up",
      escalation_lane: "defer_follow_up_review",
    },
    {
      type: "wrong_person",
      signals: ["wrong person", "not the right person", "contact someone else", "not responsible"],
      confidence: 0.88,
      dispatch_ref: "send-as:reply-router:wrong-person-cleanup",
      content_ref: "reply-router:wrong-person-cleanup",
      escalation_lane: "contact_correction_review",
    },
  ];

  for (const route of routes) {
    const matched = route.signals.filter((signal) => text.includes(signal));
    if (matched.length > 0) {
      return { ...route, signals: matched };
    }
  }
  return null;
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return value;
}

function requireNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${name} must be a finite number`);
  }
  return number;
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function excerpt(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}
