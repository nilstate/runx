import crypto from "node:crypto";
import fs from "node:fs";

const inputs = readInputs();
const evidence = objectValue(inputs.evidence, "evidence");
const policy = objectValue(inputs.policy, "policy");

const postmaster = objectValue(evidence.postmaster_report, "evidence.postmaster_report");
const bounce = objectValue(evidence.bounce_metrics, "evidence.bounce_metrics");
const complaint = objectValue(evidence.complaint_metrics, "evidence.complaint_metrics");
const placement = objectValue(evidence.placement_probe, "evidence.placement_probe");

const minReputation = numericValue(policy.min_reputation_score, "policy.min_reputation_score");
const maxBounce = numericValue(policy.max_bounce_pct, "policy.max_bounce_pct");
const maxComplaint = numericValue(policy.max_complaint_pct, "policy.max_complaint_pct");

const sealCheck = sealSignals({ postmaster, bounce, complaint, placement });
if (!sealCheck.sealed) {
  fail(`unsealed signal: ${sealCheck.unsealed}`);
}

const postmasterStatus = stringValue(postmaster.status, "postmaster_report.status");
const reputationScore = numericValue(postmaster.reputation_score, "postmaster_report.reputation_score");
const bouncePct = numericValue(bounce.bounce_pct, "bounce_metrics.bounce_pct");
const complaintPct = numericValue(complaint.complaint_pct, "complaint_metrics.complaint_pct");
const inboxRatePct = numericValue(placement.inbox_rate_pct, "placement_probe.inbox_rate_pct");

const signalEvaluations = evaluateSignals({
  postmasterStatus,
  reputationScore,
  bouncePct,
  complaintPct,
  inboxRatePct,
  minReputation,
  maxBounce,
  maxComplaint,
});

const evidenceHash = hashEvidence({ postmaster, bounce, complaint, placement });
const conflicts = findConflicts(signalEvaluations);
const verdict = buildVerdict({ signalEvaluations, conflicts, evidenceHash });
const recommendation = buildRecommendation({ verdict, signalEvaluations, evidenceHash });

emit({
  verdict,
  recommendation,
  refusal: recommendation ? null : buildRefusal({ verdict, signalEvaluations, conflicts }),
});

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  if (!process.stdin.isTTY) {
    const raw = readAllStdin();
    if (raw.trim().length === 0) {
      fail("deliverability-judge received empty input (no RUNX_INPUTS_PATH, RUNX_INPUTS_JSON, or stdin)");
    }
    return JSON.parse(raw);
  }
  fail("deliverability-judge expects JSON inputs via RUNX_INPUTS_PATH, RUNX_INPUTS_JSON, or stdin");
}

function readAllStdin() {
  return fs.readFileSync(0, "utf8");
}

function arrayValue(value, name) {
  if (!Array.isArray(value)) {
    fail(`${name} must be an array`);
  }
  return value;
}

function objectValue(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function numericValue(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${name} must be a finite number`);
  }
  return value;
}

function stringValue(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${name} must be a non-empty string`);
  }
  return value;
}

function fail(message) {
  process.stderr.write(`deliverability-judge: ${message}\n`);
  process.exit(2);
}

function sealSignals(signals) {
  const required = [
    ["postmaster", signals.postmaster],
    ["bounce", signals.bounce],
    ["complaint", signals.complaint],
    ["placement", signals.placement],
  ];
  for (const [name, block] of required) {
    if (typeof block.source !== "string" || block.source.length === 0) {
      return { sealed: false, unsealed: `${name}.source` };
    }
    if (typeof block.timestamp !== "string" || block.timestamp.length === 0) {
      return { sealed: false, unsealed: `${name}.timestamp` };
    }
  }
  return { sealed: true, unsealed: null };
}

function evaluateSignals(values) {
  return {
    postmaster: {
      healthy: values.postmasterStatus === "compliant" && values.reputationScore >= values.minReputation,
      label: "postmaster",
      reputation_score: values.reputationScore,
      min_reputation_score: values.minReputation,
    },
    bounce: {
      healthy: values.bouncePct <= values.maxBounce,
      label: "bounce",
      bounce_pct: values.bouncePct,
      max_bounce_pct: values.maxBounce,
    },
    complaint: {
      healthy: values.complaintPct <= values.maxComplaint,
      label: "complaint",
      complaint_pct: values.complaintPct,
      max_complaint_pct: values.maxComplaint,
    },
    placement: {
      healthy: values.inboxRatePct >= 85,
      label: "placement",
      inbox_rate_pct: values.inboxRatePct,
    },
  };
}

function findConflicts(signalEvaluations) {
  const healthy = Object.values(signalEvaluations).filter((s) => s.healthy).map((s) => s.label);
  const unhealthy = Object.values(signalEvaluations).filter((s) => !s.healthy).map((s) => s.label);
  return { healthy, unhealthy };
}

function hashEvidence(blocks) {
  const ordered = ["postmaster", "bounce", "complaint", "placement"].map((name) => [
    name,
    JSON.stringify(blocks[name]),
  ]);
  return "sha256:" + crypto.createHash("sha256").update(ordered.join("|")).digest("hex");
}

function buildVerdict({ signalEvaluations, conflicts, evidenceHash }) {
  const unhealthyCount = conflicts.unhealthy.length;
  if (unhealthyCount === 0) {
    return {
      state: "healthy",
      confidence_window: { low: 0.85, high: 0.97 },
      reason: "All four sealed signals agree and meet policy bounds.",
      evidence_hash: evidenceHash,
    };
  }
  const healthyCount = conflicts.healthy.length;
  if (healthyCount > 0 && unhealthyCount > 0) {
    return {
      state: "contradictory",
      confidence_window: { low: 0.0, high: 0.5 },
      reason: `Contradictory signals: healthy=${conflicts.healthy.join(",")} unhealthy=${conflicts.unhealthy.join(",")}`,
      evidence_hash: evidenceHash,
    };
  }
  return {
    state: "at_risk",
    confidence_window: { low: 0.1, high: 0.6 },
    reason: `Out-of-bound signals: ${conflicts.unhealthy.join(",")}`,
    evidence_hash: evidenceHash,
  };
}

function buildRecommendation({ verdict, signalEvaluations, evidenceHash }) {
  if (verdict.state !== "healthy") {
    return null;
  }
  const bindings = Object.entries(signalEvaluations)
    .filter(([, evaluation]) => evaluation.healthy)
    .map(([name, evaluation]) => ({ signal: name, evaluation: "healthy", bound: boundFor(name, evaluation) }));
  return {
    action: "continue",
    signal_bindings: bindings,
    evidence_hash: evidenceHash,
  };
}

function boundFor(signalName, evaluation) {
  if (signalName === "postmaster") {
    return `reputation_score>=${evaluation.min_reputation_score}`;
  }
  if (signalName === "bounce") {
    return `bounce_pct<=${evaluation.max_bounce_pct}`;
  }
  if (signalName === "complaint") {
    return `complaint_pct<=${evaluation.max_complaint_pct}`;
  }
  return `inbox_rate_pct>=85`;
}

function buildRefusal({ verdict, signalEvaluations, conflicts }) {
  if (verdict.state === "healthy") {
    return null;
  }
  if (verdict.state === "contradictory") {
    return {
      reason: "Refused: contradictory signals; no recommendation is emitted.",
      conflicting_signals: conflicts.unhealthy,
      contradictory_with: conflicts.healthy,
    };
  }
  return {
    reason: "Refused: one or more signals exceed policy bounds.",
    conflicting_signals: conflicts.unhealthy,
    contradictory_with: [],
  };
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}