const inputs = readInputs();

const sequence = objectOrNull(inputs.sequence_definition);
const rules = objectOrEmpty(sequence?.rules);
const touches = Array.isArray(sequence?.touches) ? sequence.touches : [];
const aggregateId = stringOrDefault(inputs.aggregate_id, "");
const contactRef = stringOrDefault(inputs.contact_ref, "");
const storeId = stringOrDefault(inputs.store_id, "");
const idempotencyKey = stringOrDefault(inputs.idempotency_key, "");
const expectedVersion = numberOrDefault(inputs.expected_version, 0);
const projection = normalizeProjection(inputs.prior_projection, expectedVersion);
const currentTouchIndex = numberOrDefault(
  inputs.current_touch_index,
  inferNextTouchIndex(projection.events, touches),
);

let result;
let exitCode = 0;
const missing = [];
if (!sequence) missing.push("sequence_definition is required.");
if (touches.length === 0) missing.push("sequence_definition.touches must contain at least one touch.");
if (!aggregateId) missing.push("aggregate_id is required.");
if (!contactRef) missing.push("contact_ref is required.");
if (!storeId) missing.push("store_id is required.");
if (!idempotencyKey) missing.push("idempotency_key is required.");

if (missing.length > 0) {
  result = stop("needs_input", missing.join(" "), { lane: "human-approval", reason: missing.join(" ") });
  exitCode = 2;
} else {
  result = decide();
}

process.stdout.write(`${JSON.stringify({
  schema: "runx.outreach.sequencer.v1",
  data: {
    outreach_decision: result,
  },
}, null, 2)}\n`);

process.exit(exitCode);

function readInputs() {
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {};
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringOrDefault(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeProjection(value, version) {
  const projection = objectOrEmpty(value);
  const events = Array.isArray(projection.events) ? projection.events : [];
  return {
    version: numberOrDefault(projection.version, version),
    events: events.map((event) => ({
      type: stringOrDefault(event.type, "unknown"),
      at: stringOrDefault(event.at, ""),
      touch_index: event.touch_index === null || event.touch_index === undefined ? null : numberOrDefault(event.touch_index, null),
      operation_result: objectOrEmpty(event.operation_result),
    })),
  };
}

function inferNextTouchIndex(events, touchList) {
  const sent = events
    .filter((event) => event.type === "sent")
    .map((event) => numberOrDefault(event.touch_index, 0))
    .filter((index) => index > 0);
  const lastSent = sent.length > 0 ? Math.max(...sent) : 0;
  const next = lastSent + 1;
  return touchList.some((touch) => numberOrDefault(touch.index, -1) === next) ? next : next;
}

function decide() {
  const terminal = projection.events.find((event) => event.type === "unsubscribe" || event.type === "reply");
  if (terminal) {
    return stop(terminal.type === "unsubscribe" ? "unsubscribed" : "replied", `engagement stream contains ${terminal.type}`, {
      lane: "none",
      reason: `sequence stopped by ${terminal.type}`,
    });
  }

  const latestBounce = projection.events.findLast?.((event) => event.type === "bounce")
    ?? [...projection.events].reverse().find((event) => event.type === "bounce");
  if (latestBounce && rules.advance_on_bounce !== true) {
    return stop("bounced", "bounce present and advance_on_bounce is not enabled", {
      lane: "human-approval",
      reason: "bounce requires operator review",
    });
  }

  const selectedTouch = touches.find((touch) => numberOrDefault(touch.index, -1) === currentTouchIndex);
  if (!selectedTouch) {
    return stop("sequence_complete", `touch index ${currentTouchIndex} is outside the sequence`, {
      lane: "none",
      reason: "sequence is complete",
    });
  }

  const latestSent = [...projection.events]
    .reverse()
    .find((event) => event.type === "sent" && event.at);
  const spacing = spacingDays(latestSent?.at, stringOrDefault(inputs.now, "2026-06-29T00:00:00Z"));
  const minDays = numberOrDefault(rules.min_days_apart, 0);
  if (latestSent && spacing < minDays) {
    return stop("too_soon", `prior touch was ${spacing.toFixed(2)} days ago; min_days_apart is ${minDays}`, {
      lane: "none",
      reason: "minimum spacing not satisfied",
    });
  }

  const beforeVersion = projection.version;
  const afterVersion = beforeVersion + 1;
  const principal = stringOrDefault(rules.principal, "account:outreach-operator");
  const channel = stringOrDefault(selectedTouch.channel, "email");
  const contentDigest = stringOrDefault(selectedTouch.content_digest, `sha256:touch-${currentTouchIndex}`);

  return {
    decision: {
      eligible: true,
      reason: "next_touch",
      current_touch_index: currentTouchIndex,
      next_touch_index: currentTouchIndex,
    },
    engagement_read: engagementRead(),
    append_event: {
      attempted: true,
      operation: "append_event",
      operation_result: {
        event_type: "outreach.next_touch_selected",
        before_version: beforeVersion,
        after_version: afterVersion,
        idempotency_key: idempotencyKey,
        expected_version: expectedVersion,
        aggregate_id: aggregateId,
      },
    },
    next_touch_packet: {
      packet_type: "runx.outreach.next_touch.v1",
      send_class: "outreach",
      principal,
      channel,
      audience: {
        contact_ref: contactRef,
      },
      content_digest: contentDigest,
      dispatch_idempotency_key: `${idempotencyKey}:send-as`,
      touch_index: currentTouchIndex,
      dispatch_by_naming: "send-as",
    },
    escalation: {
      lane: "none",
      reason: "handoff-only packet emitted; downstream send-as run required",
    },
  };
}

function stop(reason, detail, escalation) {
  return {
    decision: {
      eligible: false,
      reason,
      current_touch_index: currentTouchIndex,
      next_touch_index: null,
    },
    engagement_read: engagementRead(),
    append_event: {
      attempted: false,
      operation: "append_event",
      operation_result: {
        event_type: null,
        before_version: projection.version,
        after_version: null,
        idempotency_key: idempotencyKey,
        expected_version: expectedVersion,
        aggregate_id: aggregateId,
      },
    },
    next_touch_packet: null,
    refused_reason: detail,
    escalation,
  };
}

function engagementRead() {
  return {
    store_id: storeId,
    aggregate_id: aggregateId,
    operation: "read_projection",
    operation_result: {
      version: projection.version,
      events: projection.events,
    },
  };
}

function spacingDays(earlierIso, laterIso) {
  const earlier = Date.parse(earlierIso);
  const later = Date.parse(laterIso);
  if (!Number.isFinite(earlier) || !Number.isFinite(later)) return Number.POSITIVE_INFINITY;
  return (later - earlier) / 86400000;
}
