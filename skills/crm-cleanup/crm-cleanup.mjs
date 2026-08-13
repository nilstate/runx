export function parseSourceSnapshot(inputs) {
  const execution = requiredObject(inputs.http_execution, "http_execution");
  const responses = Array.isArray(execution.responses) ? execution.responses : [];
  const fetch = responses.find((entry) => record(entry).id === "crm-source");
  if (execution.decision !== "completed" || !fetch || fetch.performed !== true || fetch.ok !== true || fetch.status !== 200) {
    throw new Error("CRM source fetch must be a successful completed HTTP 200 read");
  }
  if (fetch.truncated === true) {
    throw new Error("CRM source fetch was truncated");
  }
  let parsed;
  if (fetch.json && typeof fetch.json === "object" && !Array.isArray(fetch.json)) {
    parsed = fetch.json;
  } else {
    if (typeof fetch.body !== "string") {
      throw new Error("CRM source must expose JSON text or parsed JSON");
    }
    try {
      parsed = JSON.parse(fetch.body);
    } catch {
      throw new Error("CRM source body is not valid JSON");
    }
  }
  const document = requiredObject(parsed, "CRM source document");
  const records = Array.isArray(document.records) ? document.records.map(record) : [];
  const recordId = requiredText(inputs.record_id, "record_id");
  const matches = records.filter((entry) => entry.id === recordId);
  if (matches.length !== 1) {
    throw new Error("CRM source must contain exactly one record matching record_id");
  }

  return {
    source_snapshot: {
      schema: "runx.crm_cleanup.source_snapshot.v1",
      record_id: recordId,
      record: matches[0],
      source_url: requiredText(inputs.source_url, "source_url"),
      content_digest: requiredDigest(fetch.body_digest),
    },
  };
}

export function planUpdate(inputs) {
  const transcript = requiredText(inputs.transcript, "transcript");
  const snapshot = requiredObject(inputs.source_snapshot, "source_snapshot");
  const current = requiredObject(snapshot.record, "source_snapshot.record");
  const allowedFields = uniqueStrings(record(inputs.crm_schema).allowed_fields);
  const draft = record(inputs.update_draft);
  const proposed = Array.isArray(draft.updates) ? draft.updates.map(record) : [];
  const findings = [];
  const fieldUpdates = [];
  const rejected = [];

  for (const update of proposed) {
    const recordId = textValue(update.record_id);
    const field = textValue(update.field);
    const quote = textValue(update.evidence_quote);
    if (recordId !== snapshot.record_id) {
      findings.push({ code: "update.unknown_record", message: "Update targets a record outside the fetched source snapshot." });
      continue;
    }
    if (!field || !allowedFields.includes(field)) {
      rejected.push({ record_id: recordId ?? "", field: field ?? "", reason: "field is outside the crm_schema allowlist" });
      continue;
    }
    if (!quote || !transcript.includes(quote)) {
      findings.push({ code: "update.unsupported_evidence", message: `Update to ${recordId}.${field} is not traced to a verbatim transcript quote.` });
      continue;
    }
    if (update.to === undefined || update.to === null || update.to === "") {
      findings.push({ code: "update.empty_value", message: `Update to ${recordId}.${field} carries no target value.` });
      continue;
    }
    fieldUpdates.push({
      record_id: recordId,
      field,
      from: current[field] === undefined ? null : current[field],
      to: update.to,
      evidence_quote: quote,
    });
  }

  const refused = findings.length > 0;
  const decision = refused ? "refused" : fieldUpdates.length > 0 ? "updated" : "no_action";
  const after = { ...current };
  if (!refused) {
    for (const update of fieldUpdates) after[update.field] = update.to;
  }
  const event = decision === "updated"
    ? {
        type: "crm.record.updated",
        schema: "runx.crm_cleanup.write_event.v1",
        record_id: snapshot.record_id,
        before: current,
        after,
        field_updates: fieldUpdates,
        evidence: {
          source_url: snapshot.source_url,
          source_digest: requiredDigest(snapshot.content_digest),
          transcript_digest: requiredDigest(inputs.transcript_digest),
        },
      }
    : null;

  return {
    effect_plan: {
      schema: "runx.crm_cleanup.effect_plan.v1",
      path: decision === "updated" ? "write" : "stop",
      decision,
      reason: refused
        ? "Refused because the draft was not deterministically supported by the fetched source and transcript."
        : decision === "updated"
          ? `Prepared ${fieldUpdates.length} allowlisted CRM field update(s) for one governed transport write.`
          : "No supported CRM field change was found; the transport write is skipped.",
      source_snapshot: snapshot,
      field_updates: refused ? [] : fieldUpdates,
      rejected_updates: rejected,
      event,
      validation: { status: refused ? "fail" : "pass", findings },
    },
  };
}

export function finalizeNoWrite(inputs) {
  const plan = requiredObject(inputs.effect_plan, "effect_plan");
  if (plan.path !== "stop" || !["no_action", "refused"].includes(plan.decision)) {
    throw new Error("no-write finalizer received a write plan");
  }
  const snapshot = requiredObject(plan.source_snapshot, "effect_plan.source_snapshot");
  const before = requiredObject(snapshot.record, "source_snapshot.record");
  return {
    crm_cleanup_result: resultPacket(plan, snapshot, {
      performed: false,
      transport: "data-store.append_event",
      append_status: "not_attempted",
      before_version: null,
      after_version: null,
      idempotency_key: requiredText(inputs.idempotency_key, "idempotency_key"),
      event_ref: null,
      event_digest: null,
      before,
      after: before,
      readback_verified: false,
      provider_evidence: {},
    }),
  };
}

export function finalizeWrite(inputs) {
  const plan = requiredObject(inputs.effect_plan, "effect_plan");
  if (plan.path !== "write" || plan.decision !== "updated") {
    throw new Error("write finalizer requires an updated write plan");
  }
  const append = requiredObject(inputs.append_result, "append_result");
  const readback = requiredObject(inputs.readback_result, "readback_result");
  if (append.operation !== "append_event" || !["committed", "idempotent_replay"].includes(append.status)) {
    throw new Error("append_result does not prove a committed or replayed CRM transport write");
  }
  if (readback.operation !== "read_events" || readback.status !== "read") {
    throw new Error("readback_result is not a successful event read");
  }
  if (append.aggregate_id !== readback.aggregate_id) {
    throw new Error("CRM transport aggregate changed during readback");
  }
  const events = Array.isArray(readback.events) ? readback.events : [];
  const eventRecord = events.find((entry) => record(entry).event_ref === append.event_ref);
  if (!eventRecord) throw new Error("the committed CRM write event was absent from readback");
  const readEvent = requiredObject(eventRecord.event, "readback event");
  if (stableJson(readEvent) !== stableJson(plan.event)) {
    throw new Error("the CRM write event changed during provider readback");
  }
  if (eventRecord.event_digest !== append.event_digest || eventRecord.idempotency_key !== append.idempotency_key) {
    throw new Error("CRM write digest or idempotency key changed during readback");
  }
  const snapshot = requiredObject(plan.source_snapshot, "effect_plan.source_snapshot");
  return {
    crm_cleanup_result: resultPacket(plan, snapshot, {
      performed: true,
      transport: "data-store.append_event",
      append_status: append.status,
      before_version: requiredInteger(append.before_version, "append_result.before_version"),
      after_version: requiredInteger(append.after_version, "append_result.after_version"),
      idempotency_key: requiredText(append.idempotency_key, "append_result.idempotency_key"),
      event_ref: requiredText(append.event_ref, "append_result.event_ref"),
      event_digest: requiredDigest(append.event_digest),
      before: requiredObject(readEvent.before, "readback event.before"),
      after: requiredObject(readEvent.after, "readback event.after"),
      readback_verified: true,
      provider_evidence: requiredObject(readback.provider_evidence, "readback_result.provider_evidence"),
    }),
  };
}

function resultPacket(plan, snapshot, writeResult) {
  const updates = Array.isArray(plan.field_updates) ? plan.field_updates : [];
  return {
    schema: "runx.crm_cleanup_result.v1",
    decision: plan.decision,
    reason: plan.reason,
    takeaways: plan.decision === "updated"
      ? [`Committed ${updates.length} transcript-supported CRM field update(s).`, "Provider readback matched the exact mutation event."]
      : plan.decision === "no_action"
        ? ["No transcript-supported CRM change was found.", "No CRM transport write was attempted."]
        : ["The proposed update failed deterministic evidence checks.", "No CRM transport write was attempted."],
    field_updates: updates,
    rejected_updates: Array.isArray(plan.rejected_updates) ? plan.rejected_updates : [],
    source: {
      record_id: snapshot.record_id,
      source_url: snapshot.source_url,
      content_digest: requiredDigest(snapshot.content_digest),
    },
    write_result: writeResult,
    validation: plan.validation,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredDigest(value) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error("sha256 evidence is missing or malformed");
  }
  return value;
}

function requiredText(value, field) {
  const parsed = textValue(value);
  if (!parsed) throw new Error(`${field} must be a non-empty string`);
  return parsed;
}

function requiredObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requiredInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function textValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(textValue).filter(Boolean))];
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
