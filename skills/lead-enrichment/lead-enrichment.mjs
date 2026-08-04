export function admitSignals(inputs) {
  const lead = object(inputs.lead);
  const supplied = Array.isArray(inputs.signals) ? inputs.signals : [];
  const constraints = object(inputs.constraints);
  const asOfText = text(inputs.as_of);
  const asOf = Date.parse(asOfText);
  const maxAgeDays = Number(inputs.max_age_days ?? 90);
  const blockers = [];
  const signals = [];
  const refs = new Set();
  let stopReason = "";

  if (Object.keys(lead).length === 0) blockers.push("lead is missing");
  if (!Number.isFinite(asOf)) blockers.push("as_of is invalid");
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0 || maxAgeDays > 3650) blockers.push("max_age_days is invalid");
  if (constraints.opted_in === false || constraints.do_not_contact === true) stopReason = "do_not_contact";
  if (supplied.length === 0) blockers.push("signals are empty");
  if (supplied.length > 100) blockers.push("signals exceed 100 items");

  if (Number.isFinite(asOf) && Number.isFinite(maxAgeDays)) {
    supplied.slice(0, 100).forEach((raw, position) => {
      const signal = object(raw);
      const sourceRef = text(signal.source_ref);
      const sourceDigest = text(signal.source_digest);
      const type = text(signal.type);
      const claim = text(signal.claim);
      const observedText = text(signal.observed_at);
      const observedAt = Date.parse(observedText);
      if (!sourceRef || refs.has(sourceRef) || !/^sha256:[0-9a-f]{64}$/u.test(sourceDigest) || !type || !claim || !Number.isFinite(observedAt)) {
        blockers.push(`signals[${position}] is incomplete or duplicated`);
        return;
      }
      const ageDays = (asOf - observedAt) / 86_400_000;
      if (ageDays < 0 || ageDays > maxAgeDays) {
        blockers.push(`signals[${position}] is stale or future-dated`);
        return;
      }
      refs.add(sourceRef);
      signals.push({
        source_ref: sourceRef,
        type,
        claim,
        observed_at: observedText,
        signal_digest: sourceDigest,
        provenance: "caller_supplied_source_digest",
      });
    });
  }
  if (!stopReason && blockers.length > 0) stopReason = "needs_more_evidence";

  return {
    signal_index: {
      path: stopReason ? "stop" : "synthesize",
      stop_reason: stopReason,
      lead,
      signals,
      constraints,
      as_of: asOfText,
      max_age_days: maxAgeDays,
      blockers,
    },
  };
}

export function finalizeEnrichment(inputs) {
  const index = object(inputs.signal_index);
  const draft = object(inputs.enrichment_draft);
  const signals = Array.isArray(index.signals) ? index.signals : [];
  const refs = new Set(signals.map((signal) => text(signal.source_ref)));
  const findings = strings(index.blockers).map((message) => ({ code: "lead.signal.invalid", message }));
  const stopped = text(index.stop_reason);

  if (!stopped) {
    if (text(draft.decision) !== "ready_for_review") {
      findings.push({ code: "lead.draft.not_ready", message: "draft decision is not ready_for_review" });
    }
    const evidence = Array.isArray(draft.evidence) ? draft.evidence : [];
    if (evidence.length === 0) findings.push({ code: "lead.evidence.empty", message: "enrichment has no evidence" });
    evidence.forEach((entry) => {
      const cited = strings(entry?.source_refs);
      if (!text(entry?.claim) || cited.length === 0 || cited.some((ref) => !refs.has(ref))) {
        findings.push({ code: "lead.evidence.unbound", message: "enrichment evidence cites an unknown signal" });
      }
      if (!["observed", "inferred"].includes(text(entry?.confidence))) {
        findings.push({ code: "lead.confidence.invalid", message: "confidence must be observed or inferred" });
      }
    });
  }

  const ready = !stopped && findings.length === 0;
  const decision = stopped === "do_not_contact" ? "do_not_contact" : ready ? "ready_for_review" : "needs_more_evidence";
  return {
    lead_enrichment_packet: {
      decision,
      lead_profile: ready ? object(draft.lead_profile) : object(index.lead),
      evidence: ready ? draft.evidence : [],
      fit_assessment: ready ? object(draft.fit_assessment) : {},
      recommended_action: decision === "do_not_contact"
        ? { type: "hold", reason: "consent or suppression constraint" }
        : ready ? object(draft.recommended_action) : { type: "hold" },
      risk_flags: ready && Array.isArray(draft.risk_flags) ? draft.risk_flags : [],
      signal_evidence: signals.map((signal) => ({
        source_ref: text(signal.source_ref),
        signal_digest: text(signal.signal_digest),
        type: text(signal.type),
        observed_at: text(signal.observed_at),
        provenance: text(signal.provenance),
      })),
      consent: {
        opted_in: index.constraints?.opted_in === true,
        do_not_contact: index.constraints?.do_not_contact === true,
        channels_allowed: Array.isArray(index.constraints?.channels_allowed) ? index.constraints.channels_allowed : [],
      },
      delivery_status: "not_sent",
      validation: { status: ready || decision === "do_not_contact" ? "pass" : "fail", findings },
    },
  };
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];
}
