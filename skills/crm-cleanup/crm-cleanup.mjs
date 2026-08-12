export function parseSource(inputs) {
  const fetched = object(inputs.fetch_result);
  const extracted = fetched.extracted;
  if (fetched.decision !== "ready" || typeof extracted !== "string") {
    throw new Error("CRM source fetch was not ready or did not return text");
  }

  let decoded;
  try {
    decoded = JSON.parse(extracted);
  } catch (error) {
    throw new Error(`CRM source is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const records = Array.isArray(decoded)
    ? decoded
    : Array.isArray(decoded.records)
      ? decoded.records
      : [decoded.record ?? decoded];
  const normalized = records.map(normalizeRecord).filter((record) => record.id);
  if (normalized.length === 0) throw new Error("CRM source returned no records with an id");

  return {
    source_records: normalized,
    source_read: {
      decision: fetched.decision,
      final_url: stringValue(fetched.final_url) ?? "",
      status: fetched.status,
      content_digest: stringValue(fetched.content_digest) ?? "",
      fetched_at: stringValue(object(fetched.provenance).fetched_at) ?? "",
      bytes: object(fetched.provenance).bytes ?? 0,
    },
  };
}

export function executeUpdates(inputs) {
  const source = Array.isArray(inputs.source_records) ? inputs.source_records.map(normalizeRecord) : [];
  const draft = object(inputs.update_draft);
  const schema = object(inputs.crm_schema);
  const allowed = uniqueStrings(schema.allowed_fields);
  const transcript = typeof inputs.transcript === "string" ? inputs.transcript : "";
  const recordsById = new Map(source.map((record) => [record.id, record]));
  const updates = Array.isArray(draft.updates) ? draft.updates.map(object) : [];
  const findings = [];
  const accepted = [];

  for (const update of updates) {
    const recordId = stringValue(update.record_id);
    const field = stringValue(update.field);
    const quote = stringValue(update.evidence_quote);
    const target = recordId ? recordsById.get(recordId) : undefined;
    const confidence = typeof update.confidence === "number" ? update.confidence : 0;
    if (!target) {
      findings.push({ code: "unknown_record", message: `No source record exists for ${recordId ?? "(missing)"}.` });
      continue;
    }
    if (!field || !allowed.includes(field)) {
      findings.push({ code: "field_not_allowlisted", message: `${recordId}.${field ?? "(missing)"} is outside crm_schema.allowed_fields.` });
      continue;
    }
    if (!quote || !transcript.includes(quote)) {
      findings.push({ code: "quote_not_in_transcript", message: `${recordId}.${field} has no verbatim transcript evidence.` });
      continue;
    }
    if (confidence < 0.8) {
      findings.push({ code: "low_confidence", message: `${recordId}.${field} confidence ${confidence} is below the 0.8 write threshold.` });
      continue;
    }
    if (update.to === undefined || update.to === null || update.to === "") {
      findings.push({ code: "empty_value", message: `${recordId}.${field} has no proposed value.` });
      continue;
    }
    accepted.push({
      record_id: recordId,
      field,
      from: target[field] ?? null,
      to: update.to,
      evidence_quote: quote,
      confidence,
    });
  }

  if (findings.length > 0) {
    return { write_result: {
      status: "needs_review",
      transport: "bounded-mock-crm",
      executed: false,
      reason: "One or more proposed changes failed the evidence, allowlist, or confidence gate.",
      before: [],
      after: [],
      field_updates: [],
      findings,
    } };
  }
  if (accepted.length === 0) {
    return { write_result: {
      status: "no_op",
      transport: "bounded-mock-crm",
      executed: false,
      reason: "No actionable, high-confidence field update was supported by the transcript.",
      before: [],
      after: [],
      field_updates: [],
      findings: [],
    } };
  }

  const touched = new Map();
  for (const update of accepted) {
    if (!touched.has(update.record_id)) touched.set(update.record_id, { ...recordsById.get(update.record_id) });
    touched.get(update.record_id)[update.field] = update.to;
  }
  return { write_result: {
    status: "committed",
    transport: "bounded-mock-crm",
    executed: true,
    reason: "The bounded CRM transport applied only allowlisted, high-confidence, transcript-backed updates.",
    before: accepted.map((update) => ({ record_id: update.record_id, record: { ...recordsById.get(update.record_id) } })),
    after: [...touched.entries()].map(([record_id, record]) => ({ record_id, record })),
    field_updates: accepted,
    findings: [],
    binding: { source_record_count: source.length, transcript_bound: true, allowlist_bound: true, confidence_threshold: 0.8 },
  } };
}

export function finalizeCrmCleanup(inputs) {
  const source = object(inputs.source_read);
  const write = object(inputs.write_result);
  const gate = object(inputs.confidence_gate);
  if (!source.final_url || typeof source.status !== "number" || !String(source.content_digest).startsWith("sha256:")) {
    throw new Error("source read evidence is incomplete");
  }
  if (!["committed", "no_op", "needs_review"].includes(write.status)) {
    throw new Error("CRM write result has an invalid status");
  }
  const decision = write.status === "committed" ? "updated" : write.status === "no_op" ? "no_action" : "needs_review";
  return { crm_cleanup_result: {
    schema: "runx.crm_cleanup.v1",
    decision,
    source: {
      final_url: source.final_url,
      status: source.status,
      content_digest: source.content_digest,
      fetched_at: source.fetched_at,
      bytes: source.bytes,
    },
    updates: Array.isArray(write.field_updates) ? write.field_updates : [],
    write_result: {
      status: write.status,
      transport: stringValue(write.transport) ?? "bounded-mock-crm",
      executed: write.executed === true,
      reason: stringValue(write.reason) ?? "",
      before: Array.isArray(write.before) ? write.before : [],
      after: Array.isArray(write.after) ? write.after : [],
      findings: Array.isArray(write.findings) ? write.findings : [],
    },
    no_op: write.status === "no_op",
    confidence_gate: {
      threshold: typeof gate.threshold === "number" ? gate.threshold : 0.8,
      refused_count: typeof gate.refused_count === "number" ? gate.refused_count : 0,
      human_review_required: write.status === "needs_review",
    },
    evidence: {
      source_read: true,
      transcript_digest: requiredDigest(inputs.transcript_digest),
      source_digest: source.content_digest,
      decision_bound_to_write: write.status === "committed" ? write.executed === true : true,
      field_updates_trace_to_quotes: (Array.isArray(write.field_updates) ? write.field_updates : []).every((item) => stringValue(item.evidence_quote)),
    },
  } };
}

function normalizeRecord(value) {
  const item = object(value);
  return { ...item, id: stringValue(item.id) ?? stringValue(item.record_id) ?? "" };
}

function requiredDigest(value) {
  if (typeof value !== "string" || !value.startsWith("sha256:")) throw new Error("native digest evidence is missing");
  return value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(stringValue).filter(Boolean))];
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
