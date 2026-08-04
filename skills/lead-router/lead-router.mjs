export function admitEnrichment(inputs) {
  const packet = unwrap(inputs.enrichment_packet);
  const decision = text(packet.decision);
  const validation = object(packet.validation);
  const consent = object(packet.consent);
  const signals = Array.isArray(packet.signal_evidence) ? packet.signal_evidence : [];
  const blockers = [];

  if (!["ready_for_review", "do_not_contact"].includes(decision)) blockers.push("enrichment decision is not routable");
  if (validation.status !== "pass") blockers.push("enrichment validation did not pass");
  if (text(packet.delivery_status) !== "not_sent") blockers.push("enrichment packet has an invalid delivery status");
  if (signals.some((signal) => !text(signal?.source_ref) || !/^sha256:[0-9a-f]{64}$/u.test(text(signal?.signal_digest)))) {
    blockers.push("signal evidence is incomplete");
  }
  const forcedHold = decision === "do_not_contact" || consent.do_not_contact === true || consent.opted_in === false;

  return {
    route_context: {
      path: blockers.length > 0 ? "stop" : forcedHold ? "hold" : "qualify",
      blockers,
      forced_hold: forcedHold,
      lead_profile: object(packet.lead_profile),
      fit_assessment: object(packet.fit_assessment),
      recommended_action: object(packet.recommended_action),
      signal_refs: signals.map((signal) => text(signal.source_ref)),
      consent,
    },
  };
}

export function finalizeRoute(inputs) {
  const context = object(inputs.route_context);
  const draft = object(inputs.route_draft);
  const known = new Set(strings(context.signal_refs));
  const findings = strings(context.blockers).map((message) => ({ code: "lead_route.context.invalid", message }));
  let route = context.forced_hold ? "hold" : text(draft.route);

  if (!context.forced_hold) {
    if (!["reach_out", "nurture", "hold"].includes(route)) {
      findings.push({ code: "lead_route.route.invalid", message: "route is invalid" });
    }
    const refs = strings(draft.evidence_refs);
    if (refs.length === 0 || refs.some((ref) => !known.has(ref))) {
      findings.push({ code: "lead_route.evidence.unbound", message: "route evidence cites an unknown signal" });
    }
    if (!text(draft.rationale)) {
      findings.push({ code: "lead_route.rationale.missing", message: "route rationale is missing" });
    }
    if (route === "nurture" && !text(draft.segment)) {
      findings.push({ code: "lead_route.segment.missing", message: "nurture requires a named segment" });
    }
    if (route === "reach_out" && !text(context.lead_profile?.account_id)) {
      findings.push({ code: "lead_route.audience.missing", message: "reach_out requires a bounded account audience" });
    }
  }

  const ready = context.path !== "stop" && findings.length === 0;
  const audience = route === "nurture"
    ? { type: "segment", ref: text(draft.segment) }
    : { type: "recipient", ref: text(context.lead_profile?.account_id) };
  const handoff = ready && route !== "hold" ? {
    skill: "send-as",
    runner: "plan",
    state: "prepared_for_send_planning",
    expected_outcome: "content_and_provider_preflight_required",
    inputs: {
      principal: text(inputs.principal),
      objective: text(inputs.objective),
      provider_context: object(inputs.provider_context),
      audience,
      consent_basis: context.consent?.opted_in === true
        ? "validated enrichment packet records opt-in for an allowed channel"
        : "",
      operator_context: `lead-router selected ${route}; content remains unbound and live delivery requires provider preflight and approval`,
    },
  } : {};

  return {
    lead_route_packet: {
      decision: ready ? "ready" : "needs_more_evidence",
      route: ready ? route : "hold",
      rationale: context.forced_hold ? "consent_or_suppression" : ready ? text(draft.rationale) : "",
      segment: ready ? text(draft.segment) : "",
      evidence_refs: context.forced_hold ? strings(context.signal_refs) : ready ? strings(draft.evidence_refs) : [],
      enrichment_digest: text(inputs.enrichment_digest),
      downstream_handoff: handoff,
      hold_record: ready && route === "hold"
        ? {
          recorded: true,
          record_scope: "signed_run_receipt",
          external_state_mutated: false,
          reason: context.forced_hold ? "consent_or_suppression" : "qualification_hold",
        }
        : { recorded: false, record_scope: "none", external_state_mutated: false, reason: "" },
      delivery_status: "not_sent",
      validation: { status: ready ? "pass" : "fail", findings },
    },
  };
}

function unwrap(value) {
  const item = object(value);
  return item.data && typeof item.data === "object" ? item.data : item;
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
