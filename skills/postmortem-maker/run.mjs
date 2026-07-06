import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// postmortem-maker — turn incident fragments into a traceable postmortem
// WITHOUT pretending unknowns are facts.
//
// Reads incident_timeline[], alerts[], deploy_events[], chat_notes[], and a
// postmortem_policy. Every timeline entry and every root-cause claim cites the
// input record(s) it came from (refs like incident_timeline[2], alerts[0]).
// Facts that cannot be grounded go to unknowns[] instead of the postmortem.
// A publish_proposal is emitted ONLY when the evidence is consistent and the
// policy allows it; it is a gated proposal for the doc-publisher executor
// (or send-as for comms). This skill never posts, publishes, or assigns work.

const SCHEMA = "postmortem.maker.result.v1";
const SKILL = "postmortem-maker";
const VERSION = "0.1.0";
const PUBLISH_EXECUTOR = "doc-publisher";
const MAX_RECORDS = 5000;
const MAX_TEXT = 240;

const KINDS = ["incident_timeline", "alerts", "deploy_events", "chat_notes"];
const KIND_ORDER = { incident_timeline: 0, alerts: 1, deploy_events: 2, chat_notes: 3 };
const DEFAULT_SECTIONS = ["summary", "timeline", "impact", "root_cause", "action_items"];
const SEVERITY_RANK = { critical: 4, high: 3, warning: 2, medium: 2, moderate: 2, low: 1, info: 1 };
const NEGATION_PHRASES = [
  "not the cause",
  "not the root cause",
  "not the culprit",
  "not to blame",
  "not responsible",
  "not caused",
  "not related",
  "no relation",
  "ruled out",
  "rule out",
  "rules out",
  "ruling out",
  "unrelated",
  "innocent",
  "did not cause",
  "didn't cause",
  "didn’t cause",
  "was not caused",
  "wasn't the cause",
  "wasn’t the cause",
  "was not the cause",
  "isn't the cause",
  "isn’t the cause",
  "is not the cause",
];
// A token-matching statement that both negates and talks about causation is
// treated as a dispute even when it misses the phrase list (fail closed).
const NEGATOR_RE = /\b(?:not|never)\b|n['’]t\b/i;
const CAUSAL_RE = /\b(?:cause[sd]?|causing|culprit|responsible|blame|fault|related|reason)\b/i;
const RESOLVED_STATUSES = new Set(["resolved", "ok", "closed", "recovered"]);
const RESOLUTION_RE = /\b(resolved|recovered|back to baseline|mitigated|restored)\b/i;
const IMPACT_RE = /\b(error|errors|fail|failed|failing|down|outage|degraded|latency|5xx|unable|timeout|users?)\b/i;

function main() {
  const inputs = readInputs();
  const skillRoot = process.cwd();

  // Governed refusal: postmortem-maker only drafts and PROPOSES. If asked to
  // post, publish, apply, or assign anything itself, it stops — those effects
  // belong to the gated doc-publisher executor (or send-as for comms).
  if (isTruthy(inputs.apply) || isTruthy(inputs.publish) || isTruthy(inputs.post) || isTruthy(inputs.assign)) {
    throw new Error(
      `refused: postmortem-maker never posts, publishes, or assigns work. It only emits a gated publish_proposal for the ${PUBLISH_EXECUTOR} executor (or send-as for comms). Remove 'apply'/'publish'/'post'/'assign' and route the proposal to ${PUBLISH_EXECUTOR}.`,
    );
  }

  const collections = {};
  for (const kind of KINDS) collections[kind] = normalizeCollection(inputs[kind], kind);
  const totalRecords = KINDS.reduce((n, k) => n + collections[k].length, 0);
  if (totalRecords > MAX_RECORDS) {
    throw new Error(`input evidence exceeds ${MAX_RECORDS} records; split the incident before drafting`);
  }

  // Governed refusal: with no policy or no evidence at all, nothing in a
  // postmortem could cite input evidence. Name the gaps and stop.
  const policyRaw = typeof inputs.postmortem_policy === "string" ? tryParse(inputs.postmortem_policy) : inputs.postmortem_policy;
  const gaps = [];
  if (!isPlainObject(policyRaw)) {
    gaps.push("postmortem_policy is missing or not an object, so publish gating and required sections cannot be resolved");
  }
  if (totalRecords === 0) {
    gaps.push("no incident evidence was supplied (incident_timeline, alerts, deploy_events, and chat_notes are all empty)");
  }
  if (gaps.length > 0) {
    throw new Error(
      `refused: cannot draft a traceable postmortem. Unresolved: ${gaps.join("; ")}. Every timeline entry and root-cause claim must cite input evidence; supply evidence records and a postmortem_policy, then rerun.`,
    );
  }
  const policy = normalizePolicy(policyRaw);

  const packet = buildPacket({ inputs, collections, policy });
  // evidence.json + report.md are always emitted (X.yaml declares them);
  // output_dir defaults to ./artifacts inside the skill directory.
  const outputDir =
    typeof inputs.output_dir === "string" && inputs.output_dir.trim() !== ""
      ? inputs.output_dir.trim()
      : "artifacts";
  writeArtifacts(outputDir, packet, skillRoot);
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// input handling
// ---------------------------------------------------------------------------

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  const parsed = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error(`refused: inputs must be a single JSON object of named inputs (got ${jsonType(parsed)})`);
  }
  return parsed;
}

function isTruthy(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : v;
  return s === true || s === 1 || s === "true" || s === "1" || s === "yes";
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

function normalizeCollection(v, kind) {
  if (v == null) return [];
  const parsed = typeof v === "string" ? tryParse(v) : v;
  if (typeof v === "string" && parsed === undefined) {
    throw new Error(`input '${kind}' is a string but is not valid JSON; pass an array of records`);
  }
  if (parsed == null) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(`input '${kind}' must be an array of records (got ${jsonType(parsed)})`);
  }
  return parsed.map((entry, index) => normalizeRecord(entry, kind, index));
}

function normalizeRecord(entry, kind, index) {
  const raw = isPlainObject(entry) ? entry : { text: entry == null ? "(null record)" : safeString(entry) };
  const { at, atMs } = timestampOf(raw);
  return {
    ref: `${kind}[${index}]`,
    kind,
    index,
    at,
    atMs,
    text: textOf(kind, raw),
    raw,
  };
}

function safeString(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Strings must carry an explicit UTC offset (Z or +/-HH:MM) or be a bare ISO
// date (which ECMAScript defines as UTC). Offset-less local-time strings parse
// differently per machine timezone, which would make receipts irreproducible,
// so they are treated as unparseable and the record lands in unknowns.
const TS_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const TS_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EPOCH_MS = 8.64e15; // ECMAScript maximum date range

function timestampOf(r) {
  const fields = ["at", "ts", "timestamp", "time", "when", "date", "occurred_at", "created_at"];
  for (const f of fields) {
    const v = r[f];
    let ms = null;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      ms = v >= 1e11 ? v : v * 1000; // epoch ms vs epoch seconds
    } else if (typeof v === "string" && v.trim() !== "") {
      const s = v.trim();
      if (TS_DATE_ONLY_RE.test(s) || TS_OFFSET_RE.test(s)) {
        const parsed = Date.parse(s);
        if (Number.isFinite(parsed)) ms = parsed;
      }
    }
    // Out-of-range epochs would make toISOString() throw; treat as unparseable
    // so one hostile record becomes an unknown instead of killing the run.
    if (ms != null && Number.isFinite(ms) && Math.abs(ms) <= MAX_EPOCH_MS) {
      return { at: new Date(ms).toISOString(), atMs: ms };
    }
  }
  return { at: null, atMs: null };
}

function textOf(kind, r) {
  const pick = (...names) => {
    for (const n of names) {
      if (typeof r[n] === "string" && r[n].trim() !== "") return r[n].trim();
    }
    return "";
  };
  let s = "";
  if (kind === "alerts") {
    const name = pick("monitor", "name", "alert", "id");
    const status = pick("status", "state");
    const sev = pick("severity", "sev", "priority");
    const msg = pick("summary", "message", "description", "text");
    s = [name && `alert '${name}'`, status, sev && `(severity ${sev})`, msg && `— ${msg}`].filter(Boolean).join(" ");
  } else if (kind === "deploy_events") {
    const service = pick("service", "component", "app");
    const version = pick("version", "tag", "release", "sha");
    const actor = pick("actor", "by", "author");
    const msg = pick("summary", "change", "description", "message", "text");
    s = ["deploy", service, version, actor && `by ${actor}`, msg && `— ${msg}`].filter(Boolean).join(" ");
  } else if (kind === "chat_notes") {
    const author = pick("author", "user", "from");
    const msg = pick("text", "note", "message", "summary");
    s = [author && `${author}:`, msg].filter(Boolean).join(" ");
  } else {
    s = pick("text", "description", "summary", "event", "message");
  }
  return sanitizeText(s).trim() || "(no description)";
}

// Newlines and control characters in caller-supplied text could otherwise
// break the report.md timeline table or inject fake markdown sections.
function sanitizeText(s) {
  return s.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ");
}

function truncate(s) {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}… (truncated)` : s;
}

function shortField(v, fallback) {
  if (typeof v !== "string" || v.trim() === "") return fallback;
  const s = sanitizeText(v.trim());
  return s.length > 80 ? `${s.slice(0, 80)}… (truncated)` : s;
}

function normalizePolicy(p) {
  const sections = Array.isArray(p.required_sections)
    ? p.required_sections
        .filter((s) => typeof s === "string" && s.trim() !== "")
        .map((s) => sanitizeText(s.trim()).slice(0, 60))
    : DEFAULT_SECTIONS;
  const rules = isPlainObject(p.action_item_rules) ? p.action_item_rules : {};
  let maxItems = Number.isInteger(rules.max_items) ? rules.max_items : 10;
  maxItems = Math.min(50, Math.max(1, maxItems));
  let target = null;
  if (isPlainObject(p.publish_target)) {
    target = {};
    for (const key of ["kind", "path", "channel", "space", "title"]) {
      if (typeof p.publish_target[key] === "string") target[key] = p.publish_target[key].slice(0, 200);
    }
    if (Object.keys(target).length === 0) target = null;
  }
  return {
    // Fail closed: publishing must be explicitly allowed by the policy.
    allow_publish: p.allow_publish === true,
    require_root_cause: p.require_root_cause !== false,
    required_sections: sections,
    publish_target: target,
    action_item_rules: { max_items: maxItems },
  };
}

// ---------------------------------------------------------------------------
// timeline — every entry cites the input record it came from
// ---------------------------------------------------------------------------

function buildTimeline(collections) {
  const timed = [];
  const untimedUnknowns = [];
  for (const kind of KINDS) {
    for (const r of collections[kind]) {
      if (r.atMs != null) {
        timed.push(r);
      } else {
        untimedUnknowns.push({
          kind: "untimed_record",
          detail: `'${r.ref}' has no parseable timestamp and is excluded from the timeline: "${truncate(r.text)}"`,
          evidence: [r.ref],
        });
      }
    }
  }
  timed.sort((a, b) => a.atMs - b.atMs || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.index - b.index);
  const timeline = timed.map((r) => ({
    at: r.at,
    source: r.kind,
    description: truncate(r.text),
    evidence: [r.ref],
  }));
  return { timeline, timed, untimedUnknowns };
}

// ---------------------------------------------------------------------------
// root cause — asserted only when a deploy->alert chain is corroborated
// without contradiction; otherwise undetermined, with the gap in unknowns
// ---------------------------------------------------------------------------

function analyzeRootCause(collections) {
  const unknowns = [];
  let conflictCount = 0;

  const timedAlerts = collections.alerts.filter((r) => r.atMs != null);
  const firstAlert = timedAlerts.reduce((min, r) => (min == null || r.atMs < min.atMs ? r : min), null);
  const timedTimeline = collections.incident_timeline.filter((r) => r.atMs != null);
  const firstTimelineEvent = timedTimeline.reduce((min, r) => (min == null || r.atMs < min.atMs ? r : min), null);
  const incidentStart = firstAlert || firstTimelineEvent;

  const deploys = collections.deploy_events;
  const timedDeploys = deploys.filter((r) => r.atMs != null);

  if (deploys.length > 0 && incidentStart == null) {
    unknowns.push({
      kind: "root_cause_unresolved",
      detail: "deploy events exist but no timestamped alert or timeline event marks the incident start, so deploys cannot be ordered against the incident",
      evidence: deploys.map((d) => d.ref),
    });
    return { rootCause: undetermined("no timestamped incident start to order deploy events against"), unknowns, conflictCount, firstAlert, incidentStart };
  }

  const candidates = timedDeploys
    .filter((d) => incidentStart != null && d.atMs < incidentStart.atMs)
    .map((d) => scoreCandidate(d, collections));

  const supported = candidates.filter((c) => c.corroborated_by.length > 0 && c.disputed_by.length === 0);
  const disputed = candidates.filter((c) => c.corroborated_by.length > 0 && c.disputed_by.length > 0);

  let rootCause;
  if (disputed.length > 0) {
    conflictCount += disputed.length;
    for (const c of disputed) {
      unknowns.push({
        kind: "conflicting_root_cause_evidence",
        detail: `evidence both supports and disputes ${c.label} as the cause`,
        evidence: [c.deploy, ...c.corroborated_by, ...c.disputed_by],
      });
    }
    rootCause = undetermined("evidence about the candidate deploy is contradictory", candidates);
  } else if (supported.length === 1) {
    const c = supported[0];
    const evidence = [c.deploy, ...(incidentStart ? [incidentStart.ref] : []), ...c.corroborated_by];
    rootCause = {
      status: "determined",
      statement: `${c.label} (${c.deploy}) at ${c.at} preceded the incident start at ${incidentStart.at} (${incidentStart.ref}) and is corroborated by ${c.corroborated_by.join(", ")}.`,
      evidence,
      candidates,
    };
  } else if (supported.length > 1) {
    conflictCount += 1;
    unknowns.push({
      kind: "conflicting_root_cause_evidence",
      detail: `multiple deploys are independently corroborated as the cause: ${supported.map((c) => c.label).join(" vs ")}`,
      evidence: supported.flatMap((c) => [c.deploy, ...c.corroborated_by]),
    });
    rootCause = undetermined("more than one corroborated candidate deploy", candidates);
  } else {
    const detail = candidates.length === 0
      ? "no deploy event precedes the incident start"
      : `${candidates.length} deploy(s) precede the incident start but none is corroborated by a timeline event or chat note`;
    unknowns.push({
      kind: "root_cause_unresolved",
      detail,
      evidence: [...candidates.map((c) => c.deploy), ...(incidentStart ? [incidentStart.ref] : [])],
    });
    rootCause = undetermined(detail, candidates);
  }
  return { rootCause, unknowns, conflictCount, firstAlert, incidentStart };
}

function undetermined(reason, candidates = []) {
  return {
    status: "undetermined",
    statement: `Root cause undetermined: ${reason}. No cause is asserted without citing corroborating evidence.`,
    evidence: [],
    candidates,
  };
}

function scoreCandidate(deploy, collections) {
  // Tokens match only on whole-token boundaries: a bare substring test would
  // fabricate corroboration ("api" inside "rapidly", "1.2" inside "1.25s").
  const tokenPatterns = [];
  for (const f of ["service", "component", "app", "version", "tag", "release", "sha", "id"]) {
    const v = deploy.raw[f];
    if (typeof v === "string" && v.trim().length >= 3 && v.trim().length <= 512) {
      tokenPatterns.push(new RegExp(`(?<![a-z0-9])${escapeRegex(v.trim())}(?![a-z0-9])`, "i"));
    }
  }
  const corroborated = [];
  const disputed = [];
  // Corroboration comes only from human statements: incident_timeline + chat_notes.
  for (const kind of ["incident_timeline", "chat_notes"]) {
    for (const r of collections[kind]) {
      const text = r.text.toLowerCase();
      if (!tokenPatterns.some((re) => re.test(text))) continue;
      const negated =
        NEGATION_PHRASES.some((p) => text.includes(p)) ||
        (NEGATOR_RE.test(text) && CAUSAL_RE.test(text));
      if (negated) disputed.push(r.ref);
      else corroborated.push(r.ref);
    }
  }
  const service = shortField(deploy.raw.service, "unnamed service");
  const version = shortField(deploy.raw.version, "unversioned change");
  return {
    deploy: deploy.ref,
    at: deploy.at,
    label: `deploy of ${service} ${version}`,
    service,
    version,
    corroborated_by: corroborated,
    disputed_by: disputed,
  };
}

// ---------------------------------------------------------------------------
// impact — derived strictly from evidence; no numbers are invented
// ---------------------------------------------------------------------------

function analyzeImpact(collections, firstAlert, incidentStart) {
  const unknowns = [];
  const alerts = collections.alerts;
  const resolvedAlerts = alerts.filter((r) => RESOLVED_STATUSES.has(statusOf(r)));
  const firedAlerts = alerts.filter((r) => !RESOLVED_STATUSES.has(statusOf(r)));

  let maxSeverity = null;
  let maxRank = -1;
  for (const r of firedAlerts) {
    const sev = severityOf(r);
    if (sev == null) continue;
    const rank = SEVERITY_RANK[sev.toLowerCase()] ?? 0;
    if (rank > maxRank) { maxRank = rank; maxSeverity = sev; }
  }

  // Impact window end: a resolved alert or a timestamped resolution statement.
  const resolutionRecords = [
    ...resolvedAlerts.filter((r) => r.atMs != null),
    ...collections.incident_timeline.filter((r) => r.atMs != null && RESOLUTION_RE.test(r.text)),
  ];
  const endRecord = resolutionRecords.reduce((max, r) => (max == null || r.atMs > max.atMs ? r : max), null);
  const startRecord = firstAlert || incidentStart || null;

  // A resolution timestamped BEFORE the window start contradicts the evidence:
  // no end is asserted and the contradiction is recorded as an unknown.
  const contradictoryEnd = Boolean(startRecord && endRecord && endRecord.atMs < startRecord.atMs);
  const window = {
    start: startRecord ? startRecord.at : null,
    end: endRecord && !contradictoryEnd ? endRecord.at : null,
    duration_minutes:
      startRecord && endRecord && !contradictoryEnd
        ? Math.round((endRecord.atMs - startRecord.atMs) / 60000)
        : null,
    evidence: [...(startRecord ? [startRecord.ref] : []), ...(endRecord && !contradictoryEnd ? [endRecord.ref] : [])],
  };
  if (contradictoryEnd) {
    unknowns.push({
      kind: "impact_window_contradictory",
      detail: `resolution evidence '${endRecord.ref}' (${endRecord.at}) is timestamped before the impact window start '${startRecord.ref}' (${startRecord.at}); no window end is asserted`,
      evidence: [startRecord.ref, endRecord.ref],
    });
  } else if (startRecord && !endRecord) {
    unknowns.push({
      kind: "impact_window_unresolved",
      detail: "no resolved alert or timestamped resolution statement marks the end of the impact window",
      evidence: [startRecord.ref],
    });
  }

  const statements = [];
  outer: for (const kind of ["incident_timeline", "chat_notes"]) {
    for (const r of collections[kind]) {
      if (statements.length >= 8) break outer;
      if (IMPACT_RE.test(r.text)) statements.push({ text: truncate(r.text), evidence: [r.ref] });
    }
  }

  // Fired monitors with no resolved alert for the SAME monitor stay unknown.
  // A generic timeline resolution statement never silently resolves an alert.
  const resolvedMonitors = new Set(resolvedAlerts.map(monitorOf));
  const seen = new Set();
  for (const r of firedAlerts) {
    const m = monitorOf(r);
    if (seen.has(m) || resolvedMonitors.has(m)) continue;
    seen.add(m);
    unknowns.push({
      kind: "alert_unresolved",
      detail: `alert '${m}' fired but no evidence shows it resolved`,
      evidence: [r.ref],
    });
  }

  const impact = {
    alerts_fired: firedAlerts.length,
    alerts_resolved: resolvedAlerts.length,
    max_severity: maxSeverity,
    window,
    statements,
    note: "Derived only from supplied alerts and evidence statements; no figures are inferred.",
  };
  return { impact, unknowns, firedAlerts };
}

function statusOf(r) {
  const s = typeof r.raw.status === "string" ? r.raw.status : typeof r.raw.state === "string" ? r.raw.state : "";
  return s.trim().toLowerCase();
}

function severityOf(r) {
  for (const f of ["severity", "sev", "priority"]) {
    if (typeof r.raw[f] === "string" && r.raw[f].trim() !== "") {
      return sanitizeText(r.raw[f].trim()).slice(0, 40);
    }
  }
  return null;
}

function monitorOf(r) {
  for (const f of ["monitor", "name", "alert", "id"]) {
    if (typeof r.raw[f] === "string" && r.raw[f].trim() !== "") {
      return sanitizeText(r.raw[f].trim()).toLowerCase().slice(0, 120);
    }
  }
  return r.ref;
}

// ---------------------------------------------------------------------------
// packet assembly
// ---------------------------------------------------------------------------

function buildPacket({ inputs, collections, policy }) {
  const { timeline, untimedUnknowns } = buildTimeline(collections);
  const rc = analyzeRootCause(collections);
  const im = analyzeImpact(collections, rc.firstAlert, rc.incidentStart);

  const unknowns = [...untimedUnknowns, ...rc.unknowns, ...im.unknowns];

  // Action items: each cites the evidence or unknown that motivates it, and
  // never assigns an owner — assignment is a downstream, gated effect.
  const actionItems = [];
  const push = (title, evidence, policyRule = null) => {
    actionItems.push({ id: `AI-${actionItems.length + 1}`, title, evidence, policy_rule: policyRule, owner: null });
  };
  if (rc.rootCause.status === "determined") {
    const c = rc.rootCause.candidates.find((x) => x.corroborated_by.length > 0 && x.disputed_by.length === 0);
    push(
      `Add a pre-deploy safeguard or automated rollback for ${c.service} to catch regressions like ${c.version} before rollout`,
      rc.rootCause.evidence,
    );
  }
  const seenMonitors = new Set();
  for (const r of im.firedAlerts) {
    const m = monitorOf(r);
    if (seenMonitors.has(m)) continue;
    seenMonitors.add(m);
    push(`Review alert '${m}' threshold and runbook against this incident`, [r.ref]);
  }
  for (const u of unknowns) {
    push(`Resolve unknown (${u.kind}): ${u.detail.slice(0, 140)}`, u.evidence);
  }

  // Required sections (policy) — an unmet section is an unknown, not a guess.
  const sectionHas = {
    summary: true,
    timeline: timeline.length > 0,
    impact: im.impact.alerts_fired + im.impact.alerts_resolved > 0 || im.impact.statements.length > 0,
    root_cause: rc.rootCause.status === "determined",
    action_items: actionItems.length > 0,
  };
  for (const s of policy.required_sections) {
    if (sectionHas[s] === true) continue;
    if (s === "root_cause" && !policy.require_root_cause) continue; // explicitly waived by policy
    unknowns.push({
      kind: "required_section_unmet",
      detail: `policy requires section '${s}' but the evidence cannot fill it`,
      evidence: [],
    });
    push(`Gather evidence to complete required section '${s}' before publishing`, [], `required_sections includes '${s}'`);
  }
  const cappedItems = actionItems.slice(0, policy.action_item_rules.max_items);

  const rootCauseOk = rc.rootCause.status === "determined" || !policy.require_root_cause;
  const ready = timeline.length > 0 && rootCauseOk && rc.conflictCount === 0;
  const status = ready ? "ready_for_review" : "draft_incomplete";

  const summaryText = buildSummaryText({ timeline, im, rc, unknowns, status });
  const postmortem = {
    summary: summaryText,
    timeline,
    impact: im.impact,
    root_cause: rc.rootCause,
    status,
  };

  // Gated proposal: only when the policy allows publishing AND the draft is
  // ready AND nothing is unknown. Any unknown withholds the proposal.
  const consistent = ready && unknowns.length === 0;
  const publishProposal =
    policy.allow_publish && consistent
      ? {
          kind: "publish_proposal",
          decision: "proposed",
          performed_by: PUBLISH_EXECUTOR,
          requires_approval: true,
          target: policy.publish_target || { kind: "doc", path: `postmortems/${(timeline[0].at || "").slice(0, 10)}-incident.md` },
          document: {
            title: `Postmortem: incident starting ${timeline[0].at}`,
            format: "markdown",
            sections: policy.required_sections,
          },
          postmortem_digest: `sha256:${sha256(canonical(postmortem))}`,
          note: `Proposal only. ${SKILL} posts nothing and assigns no live tasks; the ${PUBLISH_EXECUTOR} executor (or send-as for comms) performs the gated publish after approval.`,
        }
      : null;

  const rawEvidence = {};
  for (const kind of KINDS) rawEvidence[kind] = inputs[kind] ?? null;

  return {
    schema: SCHEMA,
    skill: SKILL,
    version: VERSION,
    postmortem,
    unknowns,
    action_items: cappedItems,
    publish_proposal: publishProposal,
    summary: {
      timeline_count: timeline.length,
      unknown_count: unknowns.length,
      action_item_count: cappedItems.length,
      root_cause_status: rc.rootCause.status,
      postmortem_status: status,
      proposal_status: publishProposal ? "proposed" : "withheld",
      alerts_fired: im.impact.alerts_fired,
      alerts_resolved: im.impact.alerts_resolved,
      deploys_seen: collections.deploy_events.length,
      chat_notes_seen: collections.chat_notes.length,
      impact_window_minutes: im.impact.window.duration_minutes,
    },
    policy,
    source: {
      record_counts: Object.fromEntries(KINDS.map((k) => [k, collections[k].length])),
      evidence_sha256: `sha256:${sha256(canonical(rawEvidence))}`,
    },
    validation: {
      every_timeline_entry_cites_evidence: timeline.every((e) => Array.isArray(e.evidence) && e.evidence.length > 0),
      root_cause_claim_cites_evidence: rc.rootCause.status !== "determined" || rc.rootCause.evidence.length > 0,
      unresolved_facts_in_unknowns: unknowns.every((u) => typeof u.detail === "string" && u.detail.length > 0),
      proposal_iff_consistent: (publishProposal != null) === (policy.allow_publish && consistent),
      no_live_post_or_assignment: true,
      finding_rule:
        "A timeline entry exists only for an input record with a parseable timestamp and cites its ref; a root cause is asserted only when exactly one candidate deploy preceding the incident start is corroborated by a timeline event or chat note and disputed by none — multiple corroborated candidates or any dispute yield undetermined — citing all supporting refs; untimed, contradictory, or missing facts go to unknowns[]; a publish_proposal is emitted only when the policy allows it and unknowns is empty, and it is performed by the gated doc-publisher executor — this skill never posts or assigns anything.",
    },
  };
}

function buildSummaryText({ timeline, im, rc, unknowns, status }) {
  const start = im.impact.window.start || (timeline[0] ? timeline[0].at : null);
  const end = im.impact.window.end;
  const parts = [];
  parts.push(`Incident reconstructed from ${timeline.length} evidence-cited timeline event(s)`);
  if (start) parts.push(`starting ${start}${end ? ` and resolved by ${end}` : " with an unresolved end time"}`);
  parts.push(`${im.impact.alerts_fired} alert(s) fired${im.impact.max_severity ? ` (max severity ${im.impact.max_severity})` : ""}`);
  parts.push(rc.rootCause.status === "determined" ? `root cause determined: ${rc.rootCause.statement}` : "root cause undetermined");
  parts.push(`${unknowns.length} unknown(s) outstanding`);
  parts.push(`draft status: ${status}`);
  return `${parts.join("; ")}.`;
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

function writeArtifacts(outputDir, packet, root) {
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, "evidence.json"), `${JSON.stringify(packet, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "report.md"), renderReport(packet));
}

function renderReport(packet) {
  const p = packet.postmortem;
  const lines = [];
  lines.push("# Postmortem Maker Report");
  lines.push("");
  lines.push(`- Skill: ${packet.skill} v${packet.version}`);
  lines.push(`- Draft status: ${p.status}`);
  lines.push(`- Timeline events: ${packet.summary.timeline_count}`);
  lines.push(`- Root cause: ${packet.summary.root_cause_status}`);
  lines.push(`- Unknowns: ${packet.summary.unknown_count}`);
  lines.push(`- Action items: ${packet.summary.action_item_count}`);
  lines.push(`- Publish proposal: ${packet.summary.proposal_status}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(p.summary);
  lines.push("");
  lines.push("## Timeline");
  lines.push("");
  if (p.timeline.length === 0) {
    lines.push("No timestamped evidence; see unknowns.");
  } else {
    lines.push("| At | Source | Description | Evidence |");
    lines.push("| --- | --- | --- | --- |");
    for (const e of p.timeline) {
      lines.push(`| ${e.at} | ${e.source} | ${e.description.replace(/\|/g, "\\|")} | ${e.evidence.join(", ")} |`);
    }
  }
  lines.push("");
  lines.push("## Impact");
  lines.push("");
  lines.push(`- Alerts fired: ${p.impact.alerts_fired} (resolved: ${p.impact.alerts_resolved}; max severity: ${p.impact.max_severity ?? "n/a"})`);
  lines.push(`- Window: ${p.impact.window.start ?? "unknown"} -> ${p.impact.window.end ?? "unknown"}${p.impact.window.duration_minutes != null ? ` (${p.impact.window.duration_minutes} min)` : ""}`);
  for (const s of p.impact.statements) lines.push(`- "${s.text.replace(/\|/g, "\\|")}" (${s.evidence.join(", ")})`);
  lines.push("");
  lines.push("## Root cause");
  lines.push("");
  lines.push(`${p.root_cause.statement}${p.root_cause.evidence.length ? ` Evidence: ${p.root_cause.evidence.join(", ")}.` : ""}`);
  lines.push("");
  lines.push("## Unknowns");
  lines.push("");
  if (packet.unknowns.length === 0) lines.push("None. Every fact in this draft cites input evidence.");
  else for (const u of packet.unknowns) lines.push(`- [${u.kind}] ${u.detail}${u.evidence.length ? ` (${u.evidence.join(", ")})` : ""}`);
  lines.push("");
  lines.push("## Action items");
  lines.push("");
  for (const a of packet.action_items) {
    lines.push(`- ${a.id}: ${a.title}${a.evidence.length ? ` (evidence: ${a.evidence.join(", ")})` : ""}${a.policy_rule ? ` [${a.policy_rule}]` : ""}`);
  }
  lines.push("");
  lines.push("## Guarantees");
  lines.push("");
  lines.push("- Every timeline entry and root-cause claim cites input evidence by ref.");
  lines.push("- Unresolved, untimed, or contradictory facts are recorded in unknowns, never asserted.");
  lines.push("- A publish_proposal is emitted only when the policy allows it and unknowns is empty.");
  lines.push(`- The proposal is gated: performed_by=${PUBLISH_EXECUTOR}, requires_approval=true.`);
  lines.push("- postmortem-maker posts nothing and assigns no live tasks.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ensureInside(root, resolved, label) {
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`${label} must stay inside the skill directory`);
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

// Deterministic key-sorted serialization so digests are stable regardless of
// key order. undefined is normalized to null to keep the string well-formed.
function canonical(value) {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

try {
  main();
} catch (err) {
  process.stderr.write(`postmortem-maker: ${err && err.message ? err.message : err}\n`);
  process.exit(64);
}
