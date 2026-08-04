export function indexContext(inputs) {
  const objective = text(inputs.objective);
  const asOfText = text(inputs.as_of);
  const asOf = Date.parse(asOfText);
  const maxAgeDays = Number(inputs.max_age_days ?? 30);
  const mail = object(inputs.mail_context);
  const calendar = object(inputs.calendar_context);
  const threads = Array.isArray(mail.threads) ? mail.threads : [];
  const events = Array.isArray(calendar.events) ? calendar.events : [];
  const available = Array.isArray(calendar.availability) ? calendar.availability.map(text).filter(Boolean) : [];
  const blockers = [];
  const sources = [];
  const ids = new Set();

  if (!objective) blockers.push("objective is missing");
  if (!Number.isFinite(asOf)) blockers.push("as_of is invalid");
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0 || maxAgeDays > 3650) {
    blockers.push("max_age_days is invalid");
  }
  if (threads.length === 0 && events.length === 0) blockers.push("mail and calendar context are empty");
  if (threads.length + events.length > 200) blockers.push("context exceeds 200 items");

  for (const [kind, items] of [["thread", threads], ["event", events]]) {
    items.slice(0, 200).forEach((raw, position) => {
      const item = object(raw);
      const id = text(item.id);
      const summary = text(item.summary);
      const sourceDigest = text(item.source_digest);
      const observedText = text(item.observed_at);
      const observedAt = Date.parse(observedText);
      const ageDays = (asOf - observedAt) / 86_400_000;
      if (!id || !summary || ids.has(id) || !/^sha256:[0-9a-f]{64}$/u.test(sourceDigest) || !Number.isFinite(observedAt)) {
        blockers.push(`${kind}[${position}] requires a unique id, summary, source_digest, and observed_at`);
        return;
      }
      if (!Number.isFinite(asOf) || !Number.isFinite(maxAgeDays) || ageDays < 0 || ageDays > maxAgeDays) {
        blockers.push(`${kind}[${position}] is stale or future-dated`);
        return;
      }
      ids.add(id);
      sources.push({
        source_ref: id,
        kind,
        summary,
        sensitivity: text(item.sensitivity) || "routine",
        source_digest: sourceDigest,
        observed_at: observedText,
        provenance: "caller_supplied_source_digest",
      });
    });
  }

  if (available.length > 0) {
    const evidence = object(calendar.availability_evidence);
    const sourceRef = text(evidence.source_ref);
    const sourceDigest = text(evidence.source_digest);
    const observedText = text(evidence.observed_at);
    const observedAt = Date.parse(observedText);
    const ageDays = (asOf - observedAt) / 86_400_000;
    if (!sourceRef || ids.has(sourceRef) || !/^sha256:[0-9a-f]{64}$/u.test(sourceDigest) || !Number.isFinite(observedAt)) {
      blockers.push("calendar availability requires unique source_ref, source_digest, and observed_at");
    } else if (!Number.isFinite(asOf) || !Number.isFinite(maxAgeDays) || ageDays < 0 || ageDays > maxAgeDays) {
      blockers.push("calendar availability is stale or future-dated");
    } else {
      sources.push({
        source_ref: sourceRef,
        kind: "availability",
        summary: `${available.length} supplied availability slot(s)`,
        sensitivity: "routine",
        source_digest: sourceDigest,
        observed_at: observedText,
        provenance: "caller_supplied_source_digest",
      });
    }
  }

  return {
    context_index: {
      decision: blockers.length === 0 ? "ready" : "needs_context",
      objective,
      sources,
      available_times: available,
      as_of: asOfText,
      max_age_days: maxAgeDays,
      blockers,
    },
  };
}

export function finalizeActions(inputs) {
  const index = object(inputs.context_index);
  const draft = object(inputs.action_draft);
  const sources = Array.isArray(index.sources) ? index.sources : [];
  const refs = new Set(sources.map((source) => text(source.source_ref)));
  const sourceKinds = new Map(sources.map((source) => [text(source.source_ref), text(source.kind)]));
  const available = new Set(strings(index.available_times));
  const findings = strings(index.blockers).map((message) => ({
    code: "chief_of_staff.context.invalid",
    message,
  }));
  const queues = Array.isArray(draft.priority_queue) ? draft.priority_queue : [];
  const replies = Array.isArray(draft.draft_replies) ? draft.draft_replies : [];
  const proposals = Array.isArray(draft.scheduling_proposals) ? draft.scheduling_proposals : [];

  if (index.decision === "ready") {
    if (text(draft.decision) !== "ready_for_human_review") {
      findings.push({ code: "chief_of_staff.draft.not_ready", message: "draft decision is not ready_for_human_review" });
    }
    if (queues.length === 0) {
      findings.push({ code: "chief_of_staff.priority.empty", message: "priority queue is empty" });
    }
    for (const [label, items] of [["priority_queue", queues], ["draft_replies", replies], ["scheduling_proposals", proposals]]) {
      items.forEach((item) => {
        if (!refs.has(text(item?.source_ref))) {
          findings.push({ code: "chief_of_staff.source.unknown", message: `${label} cites an unknown source_ref` });
        }
      });
    }
    queues.forEach((item) => {
      if (!["high", "medium", "low"].includes(text(item?.priority)) || !text(item?.reason)) {
        findings.push({ code: "chief_of_staff.priority.invalid", message: "priority items require high, medium, or low priority and a reason" });
      }
      if (sourceKinds.get(text(item?.source_ref)) === "availability") {
        findings.push({ code: "chief_of_staff.priority.invalid_source", message: "availability evidence cannot be prioritized as an action" });
      }
    });
    replies.forEach((reply) => {
      if (sourceKinds.get(text(reply?.source_ref)) !== "thread" || !text(reply?.subject) || !text(reply?.body_summary)) {
        findings.push({ code: "chief_of_staff.reply.invalid", message: "draft replies require a thread source, subject, and body_summary" });
      }
    });
    proposals.forEach((proposal) => {
      const times = strings(proposal?.proposed_times);
      if (times.length === 0 || times.some((time) => !available.has(time))) {
        findings.push({ code: "chief_of_staff.time.unknown", message: "scheduling proposal uses an unavailable time" });
      }
    });
  }

  const sensitive = new Set(["legal", "billing", "hr", "security", "account_access"]);
  const mandatory = sources
    .filter((source) => sensitive.has(text(source.sensitivity)))
    .map((source) => text(source.source_ref));
  const ready = index.decision === "ready" && findings.length === 0;
  const decision = !ready ? "needs_context" : mandatory.length > 0 ? "manual_review" : "ready_for_human_review";

  return {
    action_packet: {
      decision,
      priority_queue: ready ? queues : [],
      draft_replies: ready ? replies : [],
      scheduling_proposals: ready ? proposals : [],
      risks: ready && Array.isArray(draft.risks) ? draft.risks : [],
      source_evidence: sources.map((source) => ({
        source_ref: text(source.source_ref),
        source_digest: text(source.source_digest),
        kind: text(source.kind),
        sensitivity: text(source.sensitivity),
        observed_at: text(source.observed_at),
        provenance: text(source.provenance),
      })),
      mandatory_review_refs: mandatory,
      delivery_status: "not_sent",
      calendar_mutated: false,
      validation: { status: ready ? "pass" : "fail", findings },
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
