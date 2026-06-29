import fs from "node:fs";

const inputs = readInputs();
const packet = decide(inputs);

process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function decide(raw) {
  const aggregateId = requireString(raw.aggregate_id, "aggregate_id");
  const expectedVersion = requireNumber(raw.expected_version, "expected_version");
  const engagement = requireObject(raw.engagement_history, "engagement_history");
  const policy = requireObject(raw.bounce_policy, "bounce_policy");
  const consent = requireObject(raw.current_consent_state, "current_consent_state");
  const projection = raw.contact_projection && typeof raw.contact_projection === "object"
    ? raw.contact_projection
    : null;

  const hardBounces = requireNumber(engagement.hard_bounces, "engagement_history.hard_bounces");
  const recencyDays = requireNumber(engagement.recency_days, "engagement_history.recency_days");
  const decayThresholdDays = requireNumber(policy.decay_threshold_days, "bounce_policy.decay_threshold_days");
  const evidenceStatus = String(consent.evidence_status || "");
  const evidenceVersion = Number(consent.evidence_version);
  const activeUnsubscribe = consent.active_unsubscribe_marker === true;
  const projectionVersion = projection && Number.isFinite(Number(projection.version))
    ? Number(projection.version)
    : expectedVersion;

  if (activeUnsubscribe) {
    return stopPacket({
      aggregateId,
      reason: "active unsubscribe marker blocks automated re-permission",
      eventReason: "active unsubscribe marker blocks append",
      evidence: { active_unsubscribe_marker: true },
    });
  }

  if (evidenceStatus !== "read") {
    return stopPacket({
      aggregateId,
      reason: `engagement evidence status is ${evidenceStatus || "missing"}`,
      eventReason: "missing or unreadable evidence blocks append",
      evidence: { evidence_status: evidenceStatus || null },
    });
  }

  if (!Number.isFinite(evidenceVersion) || evidenceVersion !== expectedVersion) {
    return stopPacket({
      aggregateId,
      reason: `engagement evidence is stale for expected_version ${expectedVersion}`,
      eventReason: "stale evidence blocks append",
      evidence: { evidence_status: evidenceStatus, evidence_version: evidenceVersion, expected_version: expectedVersion },
    });
  }

  if (projectionVersion !== expectedVersion) {
    return stopPacket({
      aggregateId,
      reason: `contact projection version ${projectionVersion} does not match expected_version ${expectedVersion}`,
      eventReason: "stale projection blocks compare-and-set append",
      evidence: { projection_version: projectionVersion, expected_version: expectedVersion },
    });
  }

  if (hardBounces > 0 && policy.hard_bounce_action === "suppress") {
    return appendPacket({
      aggregateId,
      state: "suppress",
      fromState: String(consent.state || "unknown"),
      reason: "hard_bounces is greater than zero and hard_bounce_action is suppress",
      eventReason: "hard bounce evidence requires suppression",
      evidence: { hard_bounces: hardBounces, hard_bounce_action: policy.hard_bounce_action },
    });
  }

  if (hardBounces === 0 && recencyDays > decayThresholdDays) {
    return appendPacket({
      aggregateId,
      state: "re_permission",
      fromState: String(consent.state || "unknown"),
      reason: `recency_days ${recencyDays} is over decay_threshold_days ${decayThresholdDays} and no unsubscribe marker is present`,
      eventReason: "stale engagement requires re-permission",
      evidence: { recency_days: recencyDays, decay_threshold_days: decayThresholdDays, hard_bounces: hardBounces },
    });
  }

  return stopPacket({
    aggregateId,
    reason: "no safe automated list hygiene transition is required",
    eventReason: "no append emitted",
    evidence: { recency_days: recencyDays, decay_threshold_days: decayThresholdDays, hard_bounces: hardBounces },
  });
}

function appendPacket({ aggregateId, state, fromState, reason, eventReason, evidence }) {
  const event = {
    event_type: "list_hygiene.transitioned",
    aggregate_id: aggregateId,
    from_state: fromState,
    to_state: state,
    reason: eventReason,
    evidence,
  };
  return {
    decision_state: state,
    decision: { state, reason },
    event,
    recorded_transition: {
      state,
      event_type: event.event_type,
      append_allowed: true,
    },
    append_event_count: 1,
  };
}

function stopPacket({ aggregateId, reason, eventReason, evidence }) {
  const event = {
    event_type: "list_hygiene.review_required",
    aggregate_id: aggregateId,
    reason: eventReason,
    evidence,
  };
  return {
    decision_state: "human_review",
    decision: { state: "human_review", reason },
    event,
    recorded_transition: {
      state: "human_review",
      event_type: event.event_type,
      append_allowed: false,
    },
    append_event_count: 0,
  };
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

function requireNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${name} must be a finite number`);
  }
  return number;
}
