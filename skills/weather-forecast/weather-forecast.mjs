export default function validateForecast(inputs) {
const draft = requiredRecord(inputs.forecast_draft, "forecast_draft");
const evidence = record(inputs.forecast_evidence);
const decision = enumValue(draft.decision, ["ready", "needs_input", "needs_more_evidence", "refused"], "decision");
const requestedLocation = requiredString(inputs.location, "input.location");
const requestedHorizon = optionalString(inputs.horizon) || "";
const lifeSafety = lifeSafetyPurpose(inputs.purpose);

let output;
try {
  const location = requiredString(draft.location, "location");
  const horizon = optionalString(draft.horizon) || "";
  const forecastPacket = requiredRecord(draft.forecast_packet, "forecast_packet");
  const providerEvidence = requiredRecord(draft.provider_evidence, "provider_evidence");
  const receiptNotes = requiredRecord(draft.receipt_notes, "receipt_notes");

  assertEqual(location, requestedLocation, "location must match the requested location");
  assertEqual(horizon, requestedHorizon, "horizon must match the requested horizon");
  if (receiptNotes.authority !== "context-only" || receiptNotes.mutation !== false) {
    throw new Error("receipt_notes must preserve context-only authority with mutation false");
  }

  validateProvenance(evidence, providerEvidence, decision === "ready");
  if (decision === "ready") validateReadyEvidence(evidence, forecastPacket);
  if (lifeSafety && decision !== "refused") throw new Error("life-safety purposes must be refused");

  output = {
    decision,
    location,
    horizon,
    forecast_packet: forecastPacket,
    provider_evidence: projectProvenance(providerEvidence),
    safety_notes: strings(draft.safety_notes),
    stop_conditions: strings(draft.stop_conditions),
    receipt_notes: contextOnlyReceipt(),
  };
} catch (error) {
  output = stoppedOutput({
    decision: lifeSafety ? "refused" : "needs_more_evidence",
    location: requestedLocation,
    horizon: requestedHorizon,
    evidence,
    reason: error instanceof Error ? error.message : "deterministic evidence validation failed",
  });
}

return output;
}

function stoppedOutput({ decision, location, horizon, evidence, reason }) {
  return {
    decision,
    location,
    horizon,
    forecast_packet: {
      summary: decision === "refused"
        ? "This skill cannot support a life-safety decision."
        : "The draft could not be bound to the supplied forecast evidence.",
      periods: [],
      hazards: [],
      confidence: "not_available",
      generated_at: optionalString(evidence.generated_at) || "",
    },
    provider_evidence: projectProvenance(evidence),
    safety_notes: decision === "refused"
      ? ["Use official emergency channels and qualified authorities."]
      : [],
    stop_conditions: [`Do not use this forecast packet: ${reason}`],
    receipt_notes: contextOnlyReceipt(),
  };
}

function validateProvenance(source, projected, ready) {
  const sourceProvider = optionalString(source.provider);
  const projectedProvider = optionalString(projected.provider);
  if (ready) {
    assertEqual(requiredString(projectedProvider, "provider_evidence.provider"), requiredString(sourceProvider, "forecast_evidence.provider"), "provider must match supplied evidence");
  } else if (projectedProvider) {
    assertEqual(projectedProvider, requiredString(sourceProvider, "forecast_evidence.provider"), "provider must match supplied evidence");
  }

  const sourceRefs = strings(source.source_refs);
  const receiptRefs = strings(source.receipt_refs);
  const projectedSourceRefs = strings(projected.source_refs);
  const projectedReceiptRefs = strings(projected.receipt_refs);
  requireSubset(projectedSourceRefs, sourceRefs, "source_refs");
  requireSubset(projectedReceiptRefs, receiptRefs, "receipt_refs");

  if (ready) {
    if (sourceRefs.length === 0 && receiptRefs.length === 0) {
      throw new Error("ready forecast evidence requires at least one supplied source_ref or receipt_ref");
    }
    requireSameSet(projectedSourceRefs, sourceRefs, "source_refs");
    requireSameSet(projectedReceiptRefs, receiptRefs, "receipt_refs");
  }
}

function validateReadyEvidence(source, packet) {
  const generatedAt = requiredString(source.generated_at, "forecast_evidence.generated_at");
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("forecast_evidence.generated_at must be a valid timestamp");
  assertEqual(requiredString(packet.generated_at, "forecast_packet.generated_at"), generatedAt, "generated_at must match supplied evidence");

  const evidencePeriods = records(source.periods, "forecast_evidence.periods").map(periodName).filter(Boolean);
  const packetPeriods = records(packet.periods, "forecast_packet.periods").map(periodName).filter(Boolean);
  if (packetPeriods.length === 0) throw new Error("a ready forecast requires at least one named period");
  requireSubset(packetPeriods, evidencePeriods, "forecast periods");
}

function projectProvenance(value) {
  return {
    provider: optionalString(value.provider) || "",
    source_refs: strings(value.source_refs),
    receipt_refs: strings(value.receipt_refs),
  };
}

function contextOnlyReceipt() {
  return { authority: "context-only", mutation: false };
}

function requireSubset(values, allowed, field) {
  const allowedSet = new Set(allowed);
  for (const value of values) {
    if (!allowedSet.has(value)) throw new Error(`${field} contains a value absent from supplied evidence: ${value}`);
  }
}

function requireSameSet(actual, expected, field) {
  requireSubset(expected, actual, field);
  if (actual.length !== expected.length) throw new Error(`${field} must preserve supplied provenance exactly`);
}

function periodName(value) {
  return optionalString(value.name) || optionalString(value.label);
}

function lifeSafetyPurpose(value) {
  return /\b(?:emergency|evacuation|aviation|maritime|medical|life[- ]?safety)\b/iu.test(optionalString(value) || "");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}

function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  return value;
}

function requiredString(value, field) {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`${field} must be a non-empty string`);
  return parsed;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strings(value) {
  return Array.isArray(value) ? [...new Set(value.map(optionalString).filter(Boolean))] : [];
}

function records(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry) => requiredRecord(entry, `${field} entry`));
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requiredRecord(value, field) {
  const parsed = record(value);
  if (Object.keys(parsed).length === 0) throw new Error(`${field} must be a non-empty object`);
  return parsed;
}
