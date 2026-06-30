const STORE_ID = "runx-list-hygiene-judge-store-v1";
const ADAPTER_REF = "registry:runx/data-store@0.1.2";

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
  const value = Number(process.env[`RUNX_INPUT_${name}`]);
  if (!Number.isFinite(value)) throw new Error(`${name.toLowerCase()} must be a finite number`);
  return value;
}

function requireString(name) {
  const value = textInput(name);
  if (!value) throw new Error(`${name.toLowerCase()} is required`);
  return value;
}

function metric(object, key) {
  if (!Object.prototype.hasOwnProperty.call(object ?? {}, key)) {
    return { ok: false, reason: `missing_${key}` };
  }
  const value = Number(object[key]);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, reason: `invalid_${key}` };
  }
  return { ok: true, value };
}

function activeUnsubscribe(state) {
  if (!state || typeof state !== "object") return false;
  const normalized = String(state.state ?? "").toLowerCase();
  return state.unsubscribe_marker === true ||
    state.active_unsubscribe_marker === true ||
    ["unsubscribed", "opted_out", "suppressed_by_unsubscribe"].includes(normalized);
}

function stop(code, reason, aggregateId, idempotencyKey) {
  return {
    write: false,
    decision: { state: "stop", reason },
    stop: {
      code,
      reason,
      needs_human: true,
      human_approval_lane: "list_hygiene.human_review",
      aggregate_id: aggregateId,
      idempotency_key: idempotencyKey,
      append_emitted: false,
    },
  };
}

function decide({ engagementHistory, bouncePolicy, currentConsentState, expectedVersion, aggregateId, idempotencyKey }) {
  const projectionVersion = Number(currentConsentState?.version);
  if (!Number.isFinite(projectionVersion)) {
    return stop("missing_current_projection_version", "current_consent_state.version was not readable from the projection", aggregateId, idempotencyKey);
  }
  if (projectionVersion !== expectedVersion) {
    return stop("stale_expected_version", `expected_version ${expectedVersion} does not match projection version ${projectionVersion}; no append emitted`, aggregateId, idempotencyKey);
  }
  if (activeUnsubscribe(currentConsentState)) {
    return stop("active_unsubscribe_marker", "active unsubscribe marker blocks automated re-permission or suppression writes", aggregateId, idempotencyKey);
  }

  for (const key of ["opens_count", "clicks_count", "hard_bounces", "recency_days"]) {
    const value = metric(engagementHistory, key);
    if (!value.ok) return stop(value.reason, `data-store projection did not provide usable ${key} evidence`, aggregateId, idempotencyKey);
  }

  const hardBounces = Number(engagementHistory.hard_bounces);
  const recencyDays = Number(engagementHistory.recency_days);
  const threshold = Number(bouncePolicy?.decay_threshold_days);
  if (!Number.isFinite(threshold) || threshold < 0) {
    return stop("missing_decay_threshold", "bounce_policy.decay_threshold_days is required before judging decay", aggregateId, idempotencyKey);
  }
  const hardBounceAction = String(bouncePolicy?.hard_bounce_action ?? "").toLowerCase();
  if (hardBounces > 0 && hardBounceAction !== "suppress") {
    return stop("ambiguous_bounce_recovery", `hard_bounces=${hardBounces} but hard_bounce_action was ${hardBounceAction || "missing"}`, aggregateId, idempotencyKey);
  }

  if (hardBounces > 0) {
    return {
      write: true,
      eventType: "contact.consent_state.suppressed",
      decision: {
        state: "suppress",
        reason: `hard_bounces=${hardBounces} read from data-store; hard_bounce_action=suppress`,
      },
    };
  }

  if (recencyDays > threshold) {
    return {
      write: true,
      eventType: "contact.consent_state.re_permission_required",
      decision: {
        state: "re_permission",
        reason: `recency_days=${recencyDays} exceeds decay_threshold_days=${threshold} with no unsubscribe marker`,
      },
    };
  }

  return {
    write: true,
    eventType: "contact.consent_state.verified",
    decision: {
      state: "verify",
      reason: `recency_days=${recencyDays} is within decay_threshold_days=${threshold} and hard_bounces=0`,
    },
  };
}

function readProjection(dataSourceRef, resource, aggregateId, currentConsentState, engagementHistory) {
  return {
    adapter_ref: ADAPTER_REF,
    operation: "read_projection",
    store_id: STORE_ID,
    data_source_ref: dataSourceRef,
    resource,
    aggregate_id: aggregateId,
    projection: {
      current_consent_state: currentConsentState,
      engagement_history: engagementHistory,
    },
  };
}

function appendEvent({ dataSourceRef, resource, aggregateId, expectedVersion, idempotencyKey, currentConsentState, decision, eventType }) {
  const afterVersion = expectedVersion + 1;
  const event = {
    type: eventType,
    aggregate_id: aggregateId,
    previous_state: currentConsentState.state ?? "unknown",
    new_state: decision.state,
    reason: decision.reason,
    decided_by: "list-hygiene-judge@0.1.0",
    dispatch: "none",
    downstream_enforcer: "send-as",
  };
  return {
    adapter_ref: ADAPTER_REF,
    operation: "append_event",
    store_id: STORE_ID,
    data_source_ref: dataSourceRef,
    resource,
    aggregate_id: aggregateId,
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    cas: "ungated_compare_and_set",
    status: "committed",
    before_version: expectedVersion,
    after_version: afterVersion,
    event,
    retry_semantics: "same idempotency_key returns recorded version without double-applying",
    readback_projection: {
      aggregate_id: aggregateId,
      version: afterVersion,
      new_state: decision.state,
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
  const read = readProjection(dataSourceRef, resource, aggregateId, currentConsentState, engagementHistory);
  const verdict = decide({ engagementHistory, bouncePolicy, currentConsentState, expectedVersion, aggregateId, idempotencyKey });
  const output = {
    schema: "runx.list_hygiene_judgment.v1",
    package: "list-hygiene-judge",
    version: "0.1.0",
    decision: verdict.decision,
    data_source_ref: dataSourceRef,
    resource,
    aggregate_id: aggregateId,
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    store_id: STORE_ID,
    data_store: {
      read_projection: read,
      append_event: null,
    },
    recorded_transition: null,
    stop: verdict.stop ?? null,
    no_send: true,
    no_operational_proposal: true,
    no_minted_grant: true,
    downstream_dispatch_by_name: "send-as",
  };
  if (verdict.write) {
    const append = appendEvent({ dataSourceRef, resource, aggregateId, expectedVersion, idempotencyKey, currentConsentState, decision: verdict.decision, eventType: verdict.eventType });
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
