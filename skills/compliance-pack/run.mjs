const inputs = readInputs();

const controls = Array.isArray(inputs.controls) ? inputs.controls : [];
const evidenceRefs = Array.isArray(inputs.evidence_refs) ? inputs.evidence_refs : [];
const policy = objectOrNull(inputs.pack_policy);
const asOfDate = stringOrDefault(policy?.as_of_date, "2026-07-05");
const framework = stringOrDefault(policy?.framework, "unspecified");
const scope = stringOrDefault(policy?.scope, "unspecified");
const maxAgeDays = numberOrDefault(policy?.max_evidence_age_days, 90);
const packId = stringOrDefault(policy?.pack_id, `compliance-pack-${framework}-${asOfDate}`);

let output;
let exitCode = 0;
const missing = [];
if (controls.length === 0) missing.push("controls[] is required.");
if (evidenceRefs.length === 0) missing.push("evidence_refs[] is required.");
if (!policy) missing.push("pack_policy is required.");

if (missing.length > 0) {
  output = refused(missing.map((detail) => gap("input", "needs_human", detail)));
  exitCode = 2;
} else {
  output = buildPack();
  if (output.summary.required_gap_count > 0) {
    output.evidence_pack = null;
    output.summary.decision = "refused";
    output.summary.notes.push("Required controls have unresolved evidence gaps; no evidence_pack was emitted.");
    exitCode = 2;
  }
}

process.stdout.write(`${JSON.stringify({
  schema: "runx.compliance.pack.v1",
  data: output,
}, null, 2)}\n`);

process.exit(exitCode);

function readInputs() {
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {};
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringOrDefault(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildPack() {
  const controlMap = [];
  const gaps = [];
  const mappedEvidenceIds = new Set();

  for (const control of controls) {
    const normalizedControl = normalizeControl(control);
    const candidates = evidenceRefs
      .map(normalizeEvidence)
      .filter((evidence) => evidenceMatchesControl(evidence, normalizedControl));
    const viable = candidates
      .map((evidence) => evaluateEvidence(evidence, normalizedControl))
      .find((evaluation) => evaluation.ok);

    if (viable) {
      mappedEvidenceIds.add(viable.evidence.id);
      controlMap.push({
        control_id: normalizedControl.id,
        control_title: normalizedControl.title,
        status: "mapped",
        evidence_ref: viable.evidence.id,
        fit: `${viable.evidence.id} directly covers ${normalizedControl.id}: ${viable.evidence.summary}`,
        freshness_days: viable.freshnessDays,
      });
      continue;
    }

    const bestProblem = candidates
      .map((evidence) => evaluateEvidence(evidence, normalizedControl))
      .find((evaluation) => !evaluation.ok);
    const reason = bestProblem?.reason ?? "missing_evidence";
    const detail = bestProblem?.detail ?? `No supplied evidence ref maps to ${normalizedControl.id}.`;
    controlMap.push({
      control_id: normalizedControl.id,
      control_title: normalizedControl.title,
      status: "gap",
      evidence_ref: bestProblem?.evidence?.id ?? null,
      fit: detail,
      freshness_days: bestProblem?.freshnessDays ?? null,
    });
    gaps.push(gap(normalizedControl.id, reason, detail, normalizedControl.required));
  }

  const requiredGapCount = gaps.filter((item) => item.required !== false).length;
  const mappedControls = controlMap.filter((item) => item.status === "mapped").length;
  return {
    evidence_pack: requiredGapCount === 0
      ? {
          pack_id: packId,
          framework,
          scope,
          as_of_date: asOfDate,
          controls_total: controls.length,
          controls_mapped: mappedControls,
          evidence_refs: evidenceRefs
            .map(normalizeEvidence)
            .filter((evidence) => mappedEvidenceIds.has(evidence.id))
            .map((evidence) => ({
              id: evidence.id,
              uri: evidence.uri,
              digest: evidence.digest,
              owner: evidence.owner,
              collected_at: evidence.collected_at,
            })),
        }
      : null,
    control_map: controlMap,
    gaps,
    summary: {
      decision: requiredGapCount === 0 ? "ready" : "refused",
      mapped_controls: mappedControls,
      gap_count: gaps.length,
      required_gap_count: requiredGapCount,
      notes: [
        "Evidence pack is read-only and derived only from supplied evidence_refs.",
        "No external compliance filing, live attestation, provider call, or mutation was performed.",
      ],
    },
  };
}

function normalizeControl(control) {
  return {
    id: stringOrDefault(control?.id, "unknown-control"),
    title: stringOrDefault(control?.title, "Untitled control"),
    framework: stringOrDefault(control?.framework, framework),
    requirement: stringOrDefault(control?.requirement, ""),
    required: control?.required !== false,
    tags: Array.isArray(control?.tags) ? control.tags.map(String) : [],
  };
}

function normalizeEvidence(evidence) {
  return {
    id: stringOrDefault(evidence?.id, "unknown-evidence"),
    uri: stringOrDefault(evidence?.uri, ""),
    digest: stringOrDefault(evidence?.digest, ""),
    control_ids: Array.isArray(evidence?.control_ids) ? evidence.control_ids.map(String) : [],
    tags: Array.isArray(evidence?.tags) ? evidence.tags.map(String) : [],
    status: stringOrDefault(evidence?.status, "unknown"),
    collected_at: stringOrDefault(evidence?.collected_at, ""),
    owner: stringOrDefault(evidence?.owner, "unknown"),
    scope: stringOrDefault(evidence?.scope, "unspecified"),
    summary: stringOrDefault(evidence?.summary, "No evidence summary supplied."),
  };
}

function evidenceMatchesControl(evidence, control) {
  if (evidence.control_ids.includes(control.id)) return true;
  const tagRules = objectOrNull(policy?.tag_matches) ?? {};
  const allowedTags = Array.isArray(tagRules[control.id]) ? tagRules[control.id].map(String) : control.tags;
  return allowedTags.length > 0 && evidence.tags.some((tag) => allowedTags.includes(tag));
}

function evaluateEvidence(evidence, control) {
  const freshnessDays = daysBetween(evidence.collected_at, asOfDate);
  if (!["current", "approved", "complete"].includes(evidence.status)) {
    return {
      ok: false,
      evidence,
      freshnessDays,
      reason: "failed_evidence",
      detail: `${evidence.id} has status ${evidence.status}, not current/approved/complete.`,
    };
  }
  if (Number.isFinite(freshnessDays) && freshnessDays > maxAgeDays) {
    return {
      ok: false,
      evidence,
      freshnessDays,
      reason: "stale_evidence",
      detail: `${evidence.id} is ${freshnessDays} days old, above max_evidence_age_days ${maxAgeDays}.`,
    };
  }
  if (evidence.scope !== scope) {
    return {
      ok: false,
      evidence,
      freshnessDays,
      reason: "scope_mismatch",
      detail: `${evidence.id} scope ${evidence.scope} does not match requested scope ${scope}.`,
    };
  }
  return {
    ok: true,
    evidence,
    freshnessDays,
    reason: null,
    detail: `${evidence.id} maps to ${control.id}.`,
  };
}

function daysBetween(earlierIsoDate, laterIsoDate) {
  const earlier = Date.parse(`${earlierIsoDate}T00:00:00Z`);
  const later = Date.parse(`${laterIsoDate}T00:00:00Z`);
  if (!Number.isFinite(earlier) || !Number.isFinite(later)) return null;
  return Math.floor((later - earlier) / 86400000);
}

function gap(controlId, reason, detail, required = true) {
  return {
    control_id: controlId,
    reason,
    detail,
    required,
  };
}

function refused(gaps) {
  return {
    evidence_pack: null,
    control_map: [],
    gaps,
    summary: {
      decision: "refused",
      mapped_controls: 0,
      gap_count: gaps.length,
      required_gap_count: gaps.filter((item) => item.required !== false).length,
      notes: [
        "Required inputs were missing; no evidence_pack was emitted.",
        "No external compliance filing, live attestation, provider call, or mutation was performed.",
      ],
    },
  };
}
