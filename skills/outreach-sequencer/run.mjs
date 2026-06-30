import fs from "node:fs";
import { createHash } from "node:crypto";

const inputs = readInputs();

try {
  const output = judgeOutreach(inputs);
  emit(output);
} catch (error) {
  emit(needsHuman(error.code ?? "invalid_input", error.message));
  process.exit(2);
}

function judgeOutreach(rawInputs) {
  const sequence = objectValue(rawInputs.sequence_definition);
  const aggregateId = stringInput(rawInputs.aggregate_id, "aggregate_id");
  const contactRef = objectValue(rawInputs.contact_ref);
  const storeId = stringInput(rawInputs.store_id, "store_id");
  const idempotencyKey = stringInput(rawInputs.idempotency_key, "idempotency_key");
  const expectedVersion = numberInput(rawInputs.expected_version, "expected_version");
  const engagement = normalizeEngagement(rawInputs.engagement_projection, aggregateId, storeId, expectedVersion);
  const currentTouchIndex = normalizeCurrentTouch(rawInputs.current_touch_index, engagement.events);

  validateSequence(sequence);
  validateContact(contactRef);

  const projectionRead = {
    operation: "read_projection",
    store: "registry:runx/data-store@0.1.2",
    store_id: storeId,
    aggregate_id: aggregateId,
    version: engagement.version,
    operation_result: engagement.operation_result,
  };

  const stopEvent = engagement.events.find((event) => ["replied", "reply", "unsubscribed", "unsubscribe"].includes(event.type));
  if (stopEvent) {
    return sealed({
      decision: {
        eligible: false,
        reason: stopEvent.type.includes("unsubscribe") ? "unsubscribed" : "replied",
      },
      engagement_projection: projectionRead,
      engagement_events: observedEvents(engagement.events),
      stop_state: {
        state: "stopped",
        reason: `engagement stream contains ${stopEvent.type}`,
        operation_result: stopEvent.operation_result,
      },
      observations: baseObservations({ projectionRead, engagement, currentTouchIndex }).concat([
        {
          type: "refused_reason",
          reason: stopEvent.type.includes("unsubscribe") ? "unsubscribed" : "replied",
          linked_operation_result: stopEvent.operation_result,
        },
      ]),
    });
  }

  const touches = sequence.touches.slice().sort((a, b) => a.index - b.index);
  const nextTouch = touches.find((touch) => touch.index === currentTouchIndex + 1);
  if (!nextTouch) {
    return sealed({
      decision: {
        eligible: false,
        reason: "sequence_complete",
      },
      engagement_projection: projectionRead,
      engagement_events: observedEvents(engagement.events),
      stop_state: {
        state: "no_change",
        reason: "no next touch remains in sequence_definition.touches",
      },
      observations: baseObservations({ projectionRead, engagement, currentTouchIndex }),
    });
  }

  const minDays = minDaysApart(sequence);
  const priorTouch = latestSentTouch(engagement.events);
  if (priorTouch) {
    const now = parseDate(engagement.now, "engagement_projection.now");
    const priorAt = parseDate(priorTouch.occurred_at, "touch_sent.occurred_at");
    const ageDays = (now.getTime() - priorAt.getTime()) / 86400000;
    if (ageDays < minDays) {
      return sealed({
        decision: {
          eligible: false,
          reason: "min_days_apart_not_met",
        },
        engagement_projection: projectionRead,
        engagement_events: observedEvents(engagement.events),
        stop_state: {
          state: "wait",
          reason: `prior touch was sent ${round(ageDays)} days ago; min_days_apart is ${minDays}`,
          operation_result: priorTouch.operation_result,
        },
        observations: baseObservations({ projectionRead, engagement, currentTouchIndex }).concat([
          {
            type: "refused_reason",
            reason: "min_days_apart_not_met",
            prior_touch_index: priorTouch.touch_index,
            prior_touch_at: priorTouch.occurred_at,
            min_days_apart: minDays,
            elapsed_days: round(ageDays),
            linked_operation_result: priorTouch.operation_result,
          },
        ]),
      });
    }
  }

  const afterVersion = expectedVersion + 1;
  const dispatchIdempotencyKey = `${idempotencyKey}:dispatch`;
  const appendEvent = {
    operation: "append_event",
    store: "registry:runx/data-store@0.1.2",
    store_id: storeId,
    aggregate_id: aggregateId,
    idempotency_key: idempotencyKey,
    expected_version: expectedVersion,
    before_version: expectedVersion,
    after_version: afterVersion,
    gated: false,
    cas: "expected_version",
    event: {
      type: "outreach.next_touch_decided",
      decision_id: `decision_${hashShort(`${aggregateId}:${idempotencyKey}`)}`,
      eligible: true,
      touch_index: nextTouch.index,
      prior_touch_index: currentTouchIndex,
      dispatch_idempotency_key: dispatchIdempotencyKey,
    },
    operation_result: {
      operation: "append_event",
      status: "planned",
      before_version: expectedVersion,
      after_version: afterVersion,
    },
  };

  const packet = {
    schema: "runx.outreach.next_touch.v1",
    send_class: nextTouch.send_class || "outreach",
    principal: nextTouch.principal || contactRef.principal,
    channel: nextTouch.channel || contactRef.channel,
    audience: contactRef.audience,
    audience_role: nextTouch.audience,
    touch_index: nextTouch.index,
    content_digest: nextTouch.content_digest,
    dispatch: {
      named_run: "send-as",
      idempotency_key: dispatchIdempotencyKey,
      consequence: "separate_governed_run_required",
      this_skill_sends: false,
    },
  };

  return sealed({
    decision: {
      eligible: true,
      reason: "next_touch_due",
    },
    engagement_projection: projectionRead,
    engagement_events: observedEvents(engagement.events),
    append_event: appendEvent,
    next_touch_packet: packet,
    escalation: {
      required: false,
      lane: null,
    },
    observations: baseObservations({ projectionRead, engagement, currentTouchIndex }).concat([
      {
        type: "eligibility_verdict",
        eligible: true,
        reason: "next_touch_due",
      },
      {
        type: "append_event",
        operation_result: appendEvent.operation_result,
        idempotency_key: appendEvent.idempotency_key,
        before_version: appendEvent.before_version,
        after_version: appendEvent.after_version,
      },
      {
        type: "next_touch",
        index: nextTouch.index,
        channel: packet.channel,
        send_class: packet.send_class,
        content_digest: nextTouch.content_digest,
      },
    ]),
  });
}

function sealed(fields) {
  return {
    schema: "runx.outreach.sequencer.v1",
    status: "sealed",
    ...fields,
  };
}

function needsHuman(reasonCode, message) {
  return {
    schema: "runx.outreach.sequencer.v1",
    status: "needs_agent",
    decision: {
      eligible: false,
      reason: reasonCode,
    },
    escalation: {
      required: true,
      lane: "human_approval",
      reason_code: reasonCode,
      message,
    },
    stop_state: {
      state: "needs_human",
      reason_code: reasonCode,
      message,
    },
  };
}

function baseObservations({ projectionRead, engagement, currentTouchIndex }) {
  return [
    {
      type: "engagement_projection_read",
      operation_result: projectionRead.operation_result,
      aggregate_id: projectionRead.aggregate_id,
      store_id: projectionRead.store_id,
      version: projectionRead.version,
    },
    {
      type: "engagement_events_examined",
      events: observedEvents(engagement.events),
    },
    {
      type: "sequence_position",
      current_touch_index: currentTouchIndex,
    },
  ];
}

function observedEvents(events) {
  return events.map((event) => ({
    type: event.type,
    touch_index: event.touch_index,
    occurred_at: event.occurred_at,
    operation_result: event.operation_result,
  }));
}

function validateSequence(sequence) {
  if (!Array.isArray(sequence.touches) || sequence.touches.length === 0) {
    throw problem("missing_sequence_definition", "sequence_definition.touches must contain at least one touch.");
  }
  for (const touch of sequence.touches) {
    if (typeof touch.index !== "number") throw problem("invalid_touch_index", "every touch requires a numeric index.");
    if (!touch.content_digest) throw problem("missing_content_digest", "every touch requires content_digest.");
  }
}

function validateContact(contactRef) {
  if (!contactRef.principal) throw problem("missing_principal", "contact_ref.principal is required.");
  if (!contactRef.audience) throw problem("missing_audience", "contact_ref.audience is required.");
}

function normalizeEngagement(raw, aggregateId, storeId, expectedVersion) {
  const projection = objectValue(raw);
  if (projection.aggregate_id !== aggregateId) {
    throw problem("projection_aggregate_mismatch", "engagement_projection.aggregate_id must match aggregate_id.");
  }
  if (projection.store_id !== storeId) {
    throw problem("projection_store_mismatch", "engagement_projection.store_id must match store_id.");
  }
  if (projection.version !== expectedVersion) {
    throw problem("expected_version_mismatch", "expected_version must match engagement_projection.version.");
  }
  const result = objectValue(projection.operation_result);
  if (result.operation !== "read_projection" || result.status !== "ok") {
    throw problem("unreadable_engagement_state", "engagement_projection.operation_result must be an ok read_projection.");
  }
  const events = Array.isArray(projection.events) ? projection.events : [];
  for (const event of events) {
    const op = objectValue(event.operation_result);
    if (op.operation !== "append_event" || op.status !== "ok") {
      throw problem("unlinked_engagement_event", "every engagement event must include an ok append_event operation_result.");
    }
  }
  return {
    version: projection.version,
    operation_result: result,
    events,
    now: projection.now || new Date().toISOString(),
  };
}

function normalizeCurrentTouch(value, events) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return events
    .filter((event) => event.type === "touch_sent" && typeof event.touch_index === "number")
    .reduce((max, event) => Math.max(max, event.touch_index), 0);
}

function minDaysApart(sequence) {
  const value = objectValue(sequence.rules).min_days_apart;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function latestSentTouch(events) {
  return events
    .filter((event) => event.type === "touch_sent" && event.occurred_at)
    .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))[0];
}

function parseDate(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw problem("invalid_date", `${name} must be an ISO timestamp.`);
  return date;
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    sequence_definition: parseMaybeJson(process.env.RUNX_INPUT_SEQUENCE_DEFINITION),
    aggregate_id: parseMaybeJson(process.env.RUNX_INPUT_AGGREGATE_ID),
    contact_ref: parseMaybeJson(process.env.RUNX_INPUT_CONTACT_REF),
    current_touch_index: parseMaybeJson(process.env.RUNX_INPUT_CURRENT_TOUCH_INDEX),
    store_id: parseMaybeJson(process.env.RUNX_INPUT_STORE_ID),
    idempotency_key: parseMaybeJson(process.env.RUNX_INPUT_IDEMPOTENCY_KEY),
    expected_version: parseMaybeJson(process.env.RUNX_INPUT_EXPECTED_VERSION),
    engagement_projection: parseMaybeJson(process.env.RUNX_INPUT_ENGAGEMENT_PROJECTION),
  };
}

function parseMaybeJson(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringInput(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw problem(`missing_${name}`, `${name} is required.`);
  }
  return value.trim();
}

function numberInput(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw problem(`missing_${name}`, `${name} must be a finite number.`);
  }
  return value;
}

function hashShort(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function problem(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
