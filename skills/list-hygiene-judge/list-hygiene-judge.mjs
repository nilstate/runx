export function decide(inputs) {
  const history = record(inputs.engagement_history);
  const policy = record(inputs.bounce_policy);
  const consent = record(inputs.current_consent_state);
  const readback = record(inputs.contact_readback);
  const currentVersion = projectionVersion(readback);
  const expectedVersion = integer(inputs.expected_version);
  const aggregateId = stringValue(inputs.aggregate_id) ?? "contact:unknown";
  const idempotencyKey = stringValue(inputs.idempotency_key) ?? "consent:unknown";
  const source = stringValue(inputs.data_source_ref) ?? "";
  const resource = stringValue(inputs.resource) ?? "";
  const missing = [];

  for (const field of ["opens_count", "clicks_count", "hard_bounces", "recency_days"]) {
    if (!Number.isInteger(history[field]) || history[field] < 0) missing.push(`engagement_history.${field}`);
  }
  if (policy.hard_bounce_action !== "suppress") missing.push("bounce_policy.hard_bounce_action=suppress");
  if (!Number.isInteger(policy.decay_threshold_days) || policy.decay_threshold_days < 1) {
    missing.push("bounce_policy.decay_threshold_days");
  }
  if (!stringValue(consent.state)) missing.push("current_consent_state.state");
  if (typeof consent.unsubscribe_active !== "boolean") missing.push("current_consent_state.unsubscribe_active");

  if (missing.length > 0) {
    return packet("stop", `Stopped: required evidence is missing or invalid (${missing.join(", ")}).`, false, null, currentVersion, aggregateId, idempotencyKey, source, resource);
  }
  if (currentVersion !== expectedVersion) {
    return packet("stop", `Stopped: stale expected_version ${expectedVersion}; contact projection is at version ${currentVersion}. No append was attempted.`, false, null, currentVersion, aggregateId, idempotencyKey, source, resource);
  }
  if (consent.unsubscribe_active) {
    return packet("stop", "Stopped: an active unsubscribe marker prevents re-permission and requires human review. No append was attempted.", false, null, currentVersion, aggregateId, idempotencyKey, source, resource);
  }

  let state = "retain";
  let reason = "Evidence does not justify a consent-state transition.";
  if (history.hard_bounces > 0) {
    state = "suppress";
    reason = `Hard-bounce evidence (${history.hard_bounces}) requires suppression under the supplied policy.`;
  } else if (history.recency_days > policy.decay_threshold_days) {
    state = "re_permission";
    reason = `Engagement recency (${history.recency_days} days) exceeds the decay threshold (${policy.decay_threshold_days}) without an unsubscribe marker; re-permission is recorded for human-governed downstream use.`;
  }

  const shouldAppend = state === "suppress" || state === "re_permission";
  const event = shouldAppend ? {
    type: "contact.consent_state_changed",
    payload: {
      schema: "runx.list_hygiene_judge.v1",
      aggregate_id: aggregateId,
      idempotency_key: idempotencyKey,
      previous_state: consent.state,
      new_state: state,
      reason,
      evidence: {
        engagement_history: history,
        bounce_policy: policy,
        unsubscribe_active: consent.unsubscribe_active,
        expected_version: expectedVersion,
      },
    },
  } : null;

  return packet(state, reason, shouldAppend, event, currentVersion, aggregateId, idempotencyKey, source, resource);
}

export function finalize(inputs) {
  const packet = record(inputs.decision_packet);
  const readback = record(inputs.contact_readback);
  const append = record(inputs.append_result);
  const projection = record(inputs.projection_result);
  const beforeVersion = projectionVersion(readback);
  const shouldAppend = packet.should_append === true;
  let appendStatus = "not_appended";
  let afterVersion = beforeVersion;
  let recordedTransition = null;

  if (shouldAppend) {
    if (append.operation !== "append_event" || !Number.isInteger(append.after_version)) {
      throw new Error("append evidence is missing for a transition that required persistence");
    }
    appendStatus = append.append_status === "idempotent_replay" ? "idempotent_replay" : "committed";
    afterVersion = append.after_version;
    recordedTransition = {
      operation: append.operation,
      aggregate_id: append.aggregate_id,
      before_version: append.before_version,
      after_version: append.after_version,
      idempotency_key: append.idempotency_key,
      projection: projection,
    };
  }

  return {
    list_hygiene_decision: {
      schema: "runx.list_hygiene_judge.v1",
      aggregate_id: stringValue(packet.aggregate_id) ?? "contact:unknown",
      decision: {
        state: stringValue(packet.state) ?? "stop",
        reason: stringValue(packet.reason) ?? "No decision reason was produced.",
      },
      evidence: {
        source: stringValue(packet.source) ?? "",
        resource: stringValue(packet.resource) ?? "",
        aggregate_id: stringValue(packet.aggregate_id) ?? "",
        expected_version: integer(packet.expected_version),
        idempotency_key: stringValue(packet.idempotency_key) ?? "",
        contact_readback: readback,
      },
      persistence: { append_status: appendStatus, before_version: beforeVersion, after_version: afterVersion },
      recorded_transition: recordedTransition,
    },
  };
}

function packet(state, reason, shouldAppend, event, version, aggregateId, idempotencyKey, source, resource) {
  return {
    decision_packet: {
      state,
      reason,
      should_append: shouldAppend,
      event,
      source,
      resource,
      aggregate_id: aggregateId,
      expected_version: version,
      idempotency_key: idempotencyKey,
    },
  };
}

function projectionVersion(value) {
  const candidates = [value.version, value.current_version, value.after_version, value.projection?.version, value.data?.version];
  for (const candidate of candidates) if (Number.isInteger(candidate) && candidate >= 0) return candidate;
  return 0;
}

function integer(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
