function textInput(name) {
  return String(process.env[`RUNX_INPUT_${name}`] ?? "").trim();
}

function jsonInput(name, fallback = undefined) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name.toLowerCase()} must be valid JSON`);
  }
}

function numberInput(name) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name.toLowerCase()} must be a finite number`);
  return value;
}

function requireString(name) {
  const value = textInput(name);
  if (!value) throw new Error(`${name.toLowerCase()} is required`);
  return value;
}

function requireFiniteMetric(object, key) {
  const value = Number(object?.[key]);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, reason: `missing_or_invalid_${key}` };
  }
  return { ok: true, value };
}

function hasActiveUnsubscribe(state) {
  if (!state || typeof state !== "object") return false;
  if (state.unsubscribe_marker === true) return true;
  if (state.active_unsubscribe_marker === true) return true;
  const normalized = String(state.state ?? "").toLowerCase();
  return ["unsubscribed", "opted_out", "suppressed_by_unsubscribe"].includes(normalized);
}

function buildReadProjection({ dataSourceRef, resource, aggregateId, currentConsentState, engagementHistory }) {
  return {
    adapter_ref: "registry:runx/data-store@0.1.2",
    operation: "read_projection",
    data_source_ref: dataSourceRef,
    resource,
    aggregate_id: aggregateId,
    projection: {
      current_consent_state: currentConsentState,
      engagement_history: engagementHistory,
    },
  };
}

function decide({ engagementHistory, bouncePolicy, currentConsentState, expectedVersion }) {
  const stateVersion = Number(currentConsentState?.version);
  if (!Number.isFinite(stateVersion)) {
    return stop("missing_current_projection_version", "Current consent projection has no readable numeric version.");
  }
  if (stateVersion !== expectedVersion) {
    return stop("stale_expected_version", `expected_version ${expectedVersion} does not match current projection version ${stateVersion}.`);
  }
  if (hasActiveUnsubscribe(currentConsentState)) {
    return stop("active_unsubscribe_marker", "Active unsubscribe marker blocks automated re-permission or send eligibility changes.");
  }

  for (const key of ["opens_count", "clicks_count", "hard_bounces", "recency_days"]) {
    const metric = requireFiniteMetric(engagementHistory, key);
    if (!metric.ok) return stop(metric.reason, `Engagement evidence is missing or invalid for ${key}.`);
  }

  const hardBounces = Number(engagementHistory.hard_bounces);
  const recencyDays = Number(engagementHistory.recency_days);
  const decayThresholdDays = Number(bouncePolicy?.decay_threshold_days);
  if (!Number.isFinite(decayThresholdDays) || decayThresholdDays < 0) {
    return stop("missing_decay_threshold", "Bounce policy has no usable decay_threshold_days value.");
  }

  if (hardBounces > 0) {
    return {
      write: true,
      decision: {
        state: "suppress",
        reason: `hard_bounces=${hardBounces}; hard_bounce_action=${bouncePolicy?.hard_bounce_action ?? "suppress"}`,
      },
      event_type: "contact.consent_state.suppressed",
    };
  }

  if (recencyDays > decayThresholdDays) {
    return {
      write: true,
      decision: {
        state: "re_permission",
        reason: `recency_days=${recencyDays} exceeds decay_threshold_days=${decayThresholdDays} with no unsubscribe marker.`,
      },
      event_type: "contact.consent_state.re_permission_required",
    };
  }

  return {
    write: true,
    decision: {
      state: "verify",
      reason: `recency_days=${recencyDays} is within decay_threshold_days=${decayThresholdDays} and no hard bounce was read.`,
    },
    event_type: "contact.consent_state.verified",
  };
}

function stop(code, reason) {
  return {
    write: false,
    decision: {
      state: "stop",
      reason,
    },
    stop: {
      code,
      reason,
      human_approval_lane: "list_hygiene.review",
      append_emitted: false,
    },
  };
}

function buildAppendEvidence({
  dataSourceRef,
  resource,
  aggregateId,
  expectedVersion,
  idempotencyKey,
  currentConsentState,
  decision,
  eventType,
}) {
  const event = {
    type: eventType,
    aggregate_id: aggregateId,
    previous_state: currentConsentState.state ?? "unknown",
    new_state: decision.state,
    reason: decision.reason,
    decided_by: "list-hygiene-judge",
    dispatch: "none",
    downstream_enforcer: "send-as reads recorded consent state at send time",
  };
  const afterVersion = expectedVersion + 1;
  return {
    adapter_ref: "registry:runx/data-store@0.1.2",
    operation: "append_event",
    data_source_ref: dataSourceRef,
    resource,
    aggregate_id: aggregateId,
    expected_version: expectedVersion,
    before_version: expectedVersion,
    after_version: afterVersion,
    idempotency_key: idempotencyKey,
    status: "committed",
    event,
    readback_projection: {
      aggregate_id: aggregateId,
      version: afterVersion,
      consent_state: decision.state,
      latest_event_type: eventType,
      idempotency_key: idempotencyKey,
    },
  };
}

function main() {
  const dataSourceRef = requireString("DATA_SOURCE_REF");
  const resource = requireString("RESOURCE");
  const aggregateId = requireString("AGGREGATE_ID");
  const expectedVersion = numberInput("EXPECTED_VERSION");
  const idempotencyKey = requireString("IDEMPOTENCY_KEY");
  const engagementHistory = jsonInput("ENGAGEMENT_HISTORY", {});
  const bouncePolicy = jsonInput("BOUNCE_POLICY", {});
  const currentConsentState = jsonInput("CURRENT_CONSENT_STATE", {});

  const readProjection = buildReadProjection({
    dataSourceRef,
    resource,
    aggregateId,
    currentConsentState,
    engagementHistory,
  });
  const verdict = decide({ engagementHistory, bouncePolicy, currentConsentState, expectedVersion });
  const output = {
    schema: "runx.list_hygiene_judgment.v1",
    package: "list-hygiene-judge",
    data_source_ref: dataSourceRef,
    resource,
    aggregate_id: aggregateId,
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    decision: verdict.decision,
    data_store: {
      read_projection: readProjection,
      append_event: null,
    },
    recorded_transition: null,
    stop: verdict.stop ?? null,
    no_send: true,
    no_operational_proposal: true,
    downstream_dispatch_by_name: "send-as",
  };

  if (verdict.write) {
    const append = buildAppendEvidence({
      dataSourceRef,
      resource,
      aggregateId,
      expectedVersion,
      idempotencyKey,
      currentConsentState,
      decision: verdict.decision,
      eventType: verdict.event_type,
    });
    output.data_store.append_event = append;
    output.recorded_transition = append.readback_projection;
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
