#!/usr/bin/env node
// agency-health run.mjs
// Read-only composition of the data-store read_projection (C2) and the ledger
// read runner (C7) over one agency case. Seals a typed health verdict plus
// intervention findings, refuses to invent anything the composed read does not
// show, and emits no side effects.
//
// Required inputs:
//   data_source_ref, store_id, agency_ref
// Optional inputs:
//   period: { since, until } ISO timestamps
//   case_id (defaults to the agency's current case)
//   health_baseline: { threshold_days_stuck, cap_pressure_pct, refusal_spike_rate }
//
// Output shape matches runx.agency.health.v1 (see SKILL.md).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function readInputs() {
  // Precedence per runx runtime contract: RUNX_INPUTS_PATH (spill file written
  // by the harness) → RUNX_INPUTS_JSON (serialized env) → stdin. Without this
  // precedence, harness cases and `runx skill --input-json` invocations both
  // arrive empty even when the runner successfully serializes the case inputs.
  if (process.env.RUNX_INPUTS_PATH) {
    try {
      return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
    } catch (err) {
      fail("RUNX_INPUTS_PATH could not be parsed", { parse_error: String(err), path: process.env.RUNX_INPUTS_PATH });
    }
  }
  if (process.env.RUNX_INPUTS_JSON) {
    try {
      return JSON.parse(process.env.RUNX_INPUTS_JSON);
    } catch (err) {
      fail("RUNX_INPUTS_JSON could not be parsed", { parse_error: String(err) });
    }
  }
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail("inputs must be valid JSON", { parse_error: String(err) });
  }
}

function fail(message, extra = {}) {
  const out = {
    status: "refused",
    reason: message,
    ...extra,
  };
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0); // refused is a sealed status, not a crash
}

function need(obj, key) {
  if (obj[key] === undefined || obj[key] === null || obj[key] === "") {
    fail(`missing required input: ${key}`);
  }
  return obj[key];
}

function optional(obj, key, fallback) {
  if (obj[key] === undefined || obj[key] === null) return fallback;
  return obj[key];
}

function dataStoreRead({ data_source_ref, store_id, agency_ref, period, case_id }) {
  // C2: registry-pinned data-store read_projection keyed on agency case.
  // In this skill the data-store runner is exposed as a local deterministic
  // fixture reader so the harness and dogfood runs are reproducible without
  // a hosted harness endpoint. The fixture root is the path that the
  // runx harness points at via RUNX_FIXTURE_ROOT, or the well-known local
  // path under skills/agency-health/fixtures/.
  const root = process.env.RUNX_FIXTURE_ROOT
    ? process.env.RUNX_FIXTURE_ROOT
    : path.resolve(
        process.cwd(),
        "fixtures",
        data_source_ref,
        store_id,
        agency_ref,
        case_id ?? "current",
      );
  if (!fs.existsSync(root)) {
    return { ok: false, reason: "fixture_root_missing", root };
  }
  const events = JSON.parse(fs.readFileSync(path.join(root, "events.json"), "utf8"));
  const charter = JSON.parse(fs.readFileSync(path.join(root, "charter.json"), "utf8"));
  return { ok: true, events, charter, root };
}

function ledgerRead({ ledger_id_stubs }) {
  // C7: ledger read runner by receipt id-stub only. Audit-only; never a
  // domain-keyed state source. Stubs are file paths under the same root.
  const root = process.env.RUNX_LEDGER_ROOT || path.resolve(process.cwd(), "fixtures", "ledger");
  const out = [];
  for (const stub of ledger_id_stubs) {
    const file = path.join(root, `${stub}.json`);
    if (!fs.existsSync(file)) {
      out.push({ id_stub: stub, ok: false, reason: "ledger_stub_missing" });
      continue;
    }
    out.push({ id_stub: stub, ok: true, receipt: JSON.parse(fs.readFileSync(file, "utf8")) });
  }
  return out;
}

function inPeriod(event, period) {
  if (!period) return true;
  const t = Date.parse(event.at);
  if (Number.isNaN(t)) return false;
  if (period.since && t < Date.parse(period.since)) return false;
  if (period.until && t > Date.parse(period.until)) return false;
  return true;
}

function foldProjection({ events, period }) {
  // Fold in version order. version is a monotonic integer per case stream.
  const filtered = events.filter((e) => inPeriod(e, period));
  filtered.sort((a, b) => (a.version ?? 0) - (b.version ?? 0));
  return filtered;
}

function gradeFindings({ folded, charter, baseline, ledger_id_stubs }) {
  const findings = [];
  const sealed = folded.filter((e) => e.status === "advanced" || e.status === "resolved").length;
  const refused = folded.filter((e) => e.status === "refused" || e.status === "failed").length;
  const total = folded.length;
  const seal_rate = total === 0 ? null : sealed / total;

  const parked = folded.filter((e) => e.status === "awaiting_approval");
  const stuck_threshold_days = optional(baseline ?? {}, "threshold_days_stuck", 3);
  const stuck_count = parked.filter((e) => {
    const age_days = (Date.now() - Date.parse(e.at)) / 86400000;
    return age_days >= stuck_threshold_days;
  }).length;

  const cap_pressure_threshold = optional(baseline ?? {}, "cap_pressure_pct", 80);
  const acts_pct = charter.limits.max_acts > 0
    ? Math.round((charter.cumulative.acts / charter.limits.max_acts) * 100)
    : 0;
  const spend_pct = charter.limits.max_spend > 0
    ? Math.round((charter.cumulative.spend / charter.limits.max_spend) * 100)
    : 0;
  const cap_usage_pct = Math.max(acts_pct, spend_pct);

  const escalation_backlog = parked.length;

  const refusal_spike_threshold = optional(baseline ?? {}, "refusal_spike_rate", 0.10);
  const refusal_spike_rate = total === 0 ? null : refused / total;

  if (seal_rate !== null) {
    findings.push({
      metric: "seal_rate",
      assessment: seal_rate >= 0.9 ? "healthy" : seal_rate >= 0.7 ? "concerning" : "critical",
      norm: "seal_rate >= 0.9 healthy; >= 0.7 concerning; else critical",
      value: Number(seal_rate.toFixed(3)),
      evidence: { case_id: charter.case_id, turn: folded.length ? folded[folded.length - 1].version : null, ledger_id_stub: null },
    });
  }
  if (cap_usage_pct !== null) {
    findings.push({
      metric: "cap_usage_pct",
      assessment: cap_usage_pct < cap_pressure_threshold ? "healthy" : cap_usage_pct < 95 ? "concerning" : "critical",
      norm: `cap_usage_pct < ${cap_pressure_threshold} healthy; < 95 concerning; else critical`,
      value: cap_usage_pct,
      evidence: { case_id: charter.case_id, turn: folded.length ? folded[folded.length - 1].version : null, ledger_id_stub: null },
    });
  }
  if (escalation_backlog > 0) {
    findings.push({
      metric: "escalation_backlog",
      assessment: escalation_backlog <= 2 ? "healthy" : escalation_backlog <= 5 ? "concerning" : "critical",
      norm: "escalation_backlog <= 2 healthy; <= 5 concerning; else critical",
      value: escalation_backlog,
      evidence: { case_id: charter.case_id, turn: parked[0]?.version ?? null, ledger_id_stub: null },
    });
  }
  if (stuck_count > 0) {
    findings.push({
      metric: "stuck_case_count",
      assessment: stuck_count <= 1 ? "healthy" : stuck_count <= 3 ? "concerning" : "critical",
      norm: `stuck_case_count <= 1 healthy; <= 3 concerning; else critical (threshold_days_stuck=${stuck_threshold_days})`,
      value: stuck_count,
      evidence: { case_id: charter.case_id, turn: parked.find((e) => {
        const age_days = (Date.now() - Date.parse(e.at)) / 86400000;
        return age_days >= stuck_threshold_days;
      })?.version ?? null, ledger_id_stub: null },
    });
  }
  if (refusal_spike_rate !== null) {
    findings.push({
      metric: "refusal_spike_rate",
      assessment: refusal_spike_rate <= refusal_spike_threshold ? "healthy" : refusal_spike_rate <= 2 * refusal_spike_threshold ? "concerning" : "critical",
      norm: `refusal_spike_rate <= ${refusal_spike_threshold} healthy; <= ${2 * refusal_spike_threshold} concerning; else critical`,
      value: Number(refusal_spike_rate.toFixed(3)),
      evidence: { case_id: charter.case_id, turn: folded.length ? folded[folded.length - 1].version : null, ledger_id_stub: ledger_id_stubs[0] ?? null },
    });
  }
  return findings;
}

function emitInterventions({ findings, charter }) {
  const out = [];
  for (const f of findings) {
    if (f.assessment === "healthy") continue;
    if (f.metric === "refusal_spike_rate") {
      out.push({
        target_lane: "improve-skill",
        reason: `refusal_spike_rate at ${f.value} exceeds baseline; debug the named member behind the spike`,
        remedy_class: "debug",
        cap_widening: false,
        authority_widening: false,
        grounding: { case_id: charter.case_id, turn: f.evidence.turn, ledger_id_stub: f.evidence.ledger_id_stub },
      });
      continue;
    }
    if (f.metric === "cap_usage_pct" && f.assessment === "critical") {
      out.push({
        target_lane: "human-ops",
        reason: `cap_usage_pct at ${f.value} is critical; escalation needed before next turn appends`,
        remedy_class: "escalate",
        cap_widening: true,
        authority_widening: false,
        grounding: { case_id: charter.case_id, turn: f.evidence.turn, ledger_id_stub: f.evidence.ledger_id_stub },
      });
      continue;
    }
    out.push({
      target_lane: "policy-author",
      reason: `${f.metric} graded ${f.assessment}; tighten the policy or timeout before the next advance`,
      remedy_class: "tighten",
      cap_widening: false,
      authority_widening: false,
      grounding: { case_id: charter.case_id, turn: f.evidence.turn, ledger_id_stub: f.evidence.ledger_id_stub },
    });
  }
  return out;
}

function seal({ decision, health_verdict, intervention_findings, refusals }) {
  const out = {
    schema: "runx.agency.health.v1",
    decision,
    health_verdict,
    intervention_findings,
    refusals,
  };
  // Local receipt seal: deterministic sha256 over the canonical JSON. The
  // signed public receipt is produced separately by runx's hosted signer; the
  // local seal here is for harness reproducibility and never embeds a key.
  const canon = JSON.stringify(out, Object.keys(out).sort(), 2);
  out.receipt_local = {
    schema: "runx.receipt.local.v1",
    algorithm: "sha256",
    digest: crypto.createHash("sha256").update(canon).digest("hex"),
    sealed_at: new Date().toISOString(),
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

const inputs = readInputs();
const data_source_ref = need(inputs, "data_source_ref");
const store_id = need(inputs, "store_id");
const agency_ref = need(inputs, "agency_ref");
const period = optional(inputs, "period", null);
const case_id = optional(inputs, "case_id", null);
const baseline = optional(inputs, "health_baseline", null);
const ledger_id_stubs = optional(inputs, "ledger_id_stubs", []);

const read = dataStoreRead({ data_source_ref, store_id, agency_ref, period, case_id });
if (!read.ok) {
  seal({
    decision: "needs_more_evidence",
    health_verdict: { status: "degraded", findings: [] },
    intervention_findings: [],
    refusals: [{ when: "composition_unreadable", reason: read.reason, root: read.root }],
  });
  process.exit(0);
}

const folded = foldProjection({ events: read.events, period });
if (folded.length === 0) {
  seal({
    decision: "needs_more_evidence",
    health_verdict: { status: "degraded", findings: [] },
    intervention_findings: [],
    refusals: [{ when: "no_case_events", reason: "no readable case events over the period", period }],
  });
  process.exit(0);
}

if (ledger_id_stubs.length > 0) {
  // The composed ledger read is by id-stub only; failures are recorded but do
  // not block grading (the ledger is audit-only, never a domain source).
  ledgerRead({ ledger_id_stubs });
}

const findings = gradeFindings({
  folded,
  charter: read.charter,
  baseline,
  ledger_id_stubs,
});
const intervention_findings = emitInterventions({ findings, charter: read.charter });

const status_rank = { healthy: 0, concerning: 1, critical: 2 };
const worst = findings.reduce((acc, f) => Math.max(acc, status_rank[f.assessment] ?? 0), 0);
const status = worst >= 2 ? "critical" : worst >= 1 ? "degraded" : "healthy";
const decision = status === "critical" ? "needs_human" : "ready";

seal({
  decision,
  health_verdict: { status, findings },
  intervention_findings,
  refusals: [],
});
