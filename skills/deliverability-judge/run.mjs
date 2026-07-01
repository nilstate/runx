import crypto from "node:crypto";

function parseJsonInput(name) {
  const raw = process.env[`RUNX_INPUT_${name.toUpperCase()}`];
  if (!raw) {
    throw new Error(`${name} is required`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be valid JSON`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function evidenceHash(evidence) {
  return crypto.createHash("sha256").update(stableJson(evidence)).digest("hex");
}

function hasSeal(signal) {
  return Boolean(signal && typeof signal.source === "string" && signal.source && typeof signal.timestamp === "string" && signal.timestamp);
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function evaluate(evidence, policy) {
  const requiredSignals = [
    "postmaster_report",
    "bounce_metrics",
    "complaint_metrics",
    "placement_probe",
  ];
  const missing = requiredSignals.filter((name) => !evidence?.[name]);
  const unsealed = requiredSignals.filter((name) => evidence?.[name] && !hasSeal(evidence[name]));

  const policyMissing = [
    "min_reputation_score",
    "max_bounce_pct",
    "max_complaint_pct",
  ].filter((name) => !numberValue(policy?.[name]));

  if (missing.length || unsealed.length || policyMissing.length) {
    return {
      verdict: {
        state: "escalate",
        confidence_window: "none",
        reason: "missing_or_unsealed_signal",
      },
      escalation: {
        reason: "A complete sealed signal set and numeric policy thresholds are required.",
        missing_signals: missing,
        unsealed_signals: unsealed,
        missing_policy: policyMissing,
      },
    };
  }

  const reputation = evidence.postmaster_report.reputation_score;
  const bounce = evidence.bounce_metrics.bounce_pct;
  const complaint = evidence.complaint_metrics.complaint_pct;
  const placementPassed = evidence.placement_probe.passed === true;

  const invalidNumeric = [];
  if (!numberValue(reputation)) invalidNumeric.push("postmaster_report.reputation_score");
  if (!numberValue(bounce)) invalidNumeric.push("bounce_metrics.bounce_pct");
  if (!numberValue(complaint)) invalidNumeric.push("complaint_metrics.complaint_pct");

  if (invalidNumeric.length || typeof evidence.placement_probe.passed !== "boolean") {
    return {
      verdict: {
        state: "escalate",
        confidence_window: "none",
        reason: "invalid_signal_shape",
      },
      escalation: {
        reason: "Signals must expose numeric reputation, bounce, complaint, and boolean placement result.",
        invalid_signals: invalidNumeric.concat(typeof evidence.placement_probe.passed !== "boolean" ? ["placement_probe.passed"] : []),
      },
    };
  }

  const reputationOk = reputation >= policy.min_reputation_score;
  const bounceOk = bounce <= policy.max_bounce_pct;
  const complaintOk = complaint <= policy.max_complaint_pct;

  const contradictions = [];
  if (reputationOk && !bounceOk) contradictions.push("high_reputation_conflicts_with_high_bounce");
  if (reputationOk && !complaintOk) contradictions.push("high_reputation_conflicts_with_high_complaint");
  if (reputationOk && !placementPassed) contradictions.push("high_reputation_conflicts_with_failed_placement_probe");

  if (contradictions.length) {
    return {
      verdict: {
        state: "escalate",
        confidence_window: "low",
        reason: "contradictory_signals",
      },
      escalation: {
        reason: "Signals disagree, so no read-only recommendation is emitted.",
        contradictions,
        signal_names: ["postmaster_report", "bounce_metrics", "complaint_metrics", "placement_probe"],
      },
    };
  }

  const healthy = reputationOk && bounceOk && complaintOk && placementPassed;
  const allBad = !reputationOk && !bounceOk && !complaintOk && !placementPassed;
  const action = healthy ? "continue" : allBad ? "pause" : "throttle";
  const confidence = healthy ? "high" : allBad ? "medium" : "medium-low";

  return {
    verdict: {
      state: healthy ? "healthy" : "risk",
      confidence_window: confidence,
      reason: healthy ? "all_sealed_signals_pass_policy" : "aligned_deliverability_risk",
    },
    recommendation: {
      action,
      signal_bindings: {
        postmaster_report: evidence.postmaster_report.source,
        bounce_metrics: evidence.bounce_metrics.source,
        complaint_metrics: evidence.complaint_metrics.source,
        placement_probe: evidence.placement_probe.source,
      },
      evidence_hash: evidenceHash(evidence),
    },
  };
}

try {
  const evidence = parseJsonInput("evidence");
  const policy = parseJsonInput("policy");
  const result = evaluate(evidence, policy);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(64);
}
