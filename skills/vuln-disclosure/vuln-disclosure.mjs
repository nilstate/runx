export function admitDisclosure(inputs) {
  const packet = object(inputs.advisory_packet);
  const target = object(inputs.target);
  const findings = [];
  const finding = (code, message) => findings.push({ code, message });
  if (packet.schema !== "runx.security.vulnerability_advisory.v1") finding("disclosure.packet.schema", "advisory_packet must be runx.security.vulnerability_advisory.v1");
  if (packet.decision !== "ready_for_review") finding("disclosure.packet.decision", "advisory packet must be ready_for_review");
  if (object(packet.validation).status !== "pass") finding("disclosure.packet.validation", "advisory packet validation must pass");
  if (packet.publication_status !== "not_published") finding("disclosure.packet.state", "advisory packet must not already claim publication");
  const channel = text(inputs.channel, 100);
  if (!channel) finding("disclosure.channel.missing", "channel is required");
  if (!text(target.locator, 1_000)) finding("disclosure.target.missing", "target.locator is required");
  const draft = object(packet.advisory_draft);
  const advisoryIds = strings(draft.affected_advisory_ids, 500);
  if (!text(draft.title) || !text(draft.body) || advisoryIds.length === 0) finding("disclosure.draft.incomplete", "advisory title, body, and affected advisory ids are required");
  const evidence = object(packet.evidence_binding);
  if (!text(evidence.receipt_ref) || !text(evidence.evidence_digest)) finding("disclosure.evidence.missing", "advisory evidence binding is required");

  return {
    disclosure_context: {
      schema: "runx.security.vulnerability_disclosure_context.v1",
      path: findings.length === 0 ? "review" : "stop",
      stop_decision: findings.some(({ code }) => code.endsWith(".missing")) ? "needs_agent" : "needs_verified_evidence",
      channel,
      target,
      payload: {
        title: text(draft.title, 500),
        summary: text(draft.summary, 2_000),
        body: text(draft.body, 20_000),
        affected_advisory_ids: advisoryIds,
      },
      disclosure_checklist: strings(packet.disclosure_checklist, 100),
      source_advisories: array(packet.source_advisories).slice(0, 500),
      remediation_plan: object(packet.remediation_plan),
      evidence_binding: evidence,
      disclosure_context: object(inputs.disclosure_context),
      findings,
    },
  };
}

export function finalizeDisclosure(inputs) {
  const context = object(inputs.disclosure_context);
  const review = object(inputs.disclosure_review_draft);
  const findings = array(context.findings).slice();
  const finding = (code, message) => findings.push({ code, message });
  const expectedIds = strings(object(context.payload).affected_advisory_ids, 500).sort();
  const reviewedIds = strings(review.affected_advisory_ids, 500).sort();
  if (context.path === "review") {
    if (!["ready_for_approval", "hold"].includes(text(review.decision))) finding("disclosure.review.decision", "review decision must be ready_for_approval or hold");
    if (!text(review.rationale)) finding("disclosure.review.rationale", "review rationale is required");
    if (JSON.stringify(expectedIds) !== JSON.stringify(reviewedIds)) finding("disclosure.review.unbound", "reviewed advisory ids must exactly match the admitted advisory");
  }
  const payload = object(context.payload);
  const payloadDigest = payload.title ? text(inputs.payload_digest, 80) : "";
  if (payload.title && !/^sha256:[0-9a-f]{64}$/u.test(payloadDigest)) {
    finding("disclosure.payload.unbound", "native publication payload digest is missing");
  }
  const decision = context.path === "stop"
    ? context.stop_decision
    : findings.length > 0
      ? "needs_more_evidence"
      : review.decision === "hold"
        ? "hold"
        : "ready_for_publication_approval";

  return {
    disclosure_packet: {
      schema: "runx.security.vulnerability_disclosure.v1",
      decision,
      channel: context.channel,
      target: context.target,
      payload,
      payload_digest: payloadDigest,
      review: context.path === "review" ? {
        rationale: text(review.rationale, 4_000),
        checklist: strings(review.checklist, 100),
        affected_advisory_ids: reviewedIds,
      } : {},
      remediation_plan: context.remediation_plan,
      evidence_binding: context.evidence_binding,
      validation: { status: findings.length === 0 ? "pass" : "fail", findings },
      approval_status: "not_requested",
      publication_status: "not_published",
      provider_status: "not_called",
      next_action: decision === "ready_for_publication_approval" ? "route through an approved provider publication adapter" : "resolve the recorded hold or evidence gaps",
    },
  };
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function array(value) { return Array.isArray(value) ? value : []; }
function strings(value, max) { return array(value).map((item) => text(item, 1_000)).filter(Boolean).slice(0, max); }
function text(value, max = 1_000) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
