import crypto from "node:crypto";

function jsonInput(name, fallback = undefined) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name.toLowerCase()} must be valid JSON`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function evidenceHash(evidence) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(evidence)).digest("hex")}`;
}

function numberAt(object, key) {
  const value = Number(object?.[key]);
  return Number.isFinite(value) ? value : null;
}

function signalStatus(name, signal, metricKey, policyLabel, pass) {
  const missing = !signal || typeof signal !== "object";
  return {
    name,
    sealed: signal?.sealed === true,
    source: signal?.source ?? null,
    timestamp: signal?.timestamp ?? null,
    metric: metricKey,
    value: missing ? null : numberAt(signal, metricKey),
    policy: policyLabel,
    pass,
  };
}

function refusal(code, reason, signalNames, evaluations, hash) {
  return {
    verdict: {
      state: "escalate",
      confidence_window: [0, 0],
      reason,
    },
    recommendation: null,
    escalation: {
      status: "needs_human_reviewer",
      code,
      reason,
      contradicting_or_missing_signals: signalNames,
    },
    signal_evaluations: evaluations,
    evidence_hash: hash,
  };
}

function judge(evidence, policy) {
  const hash = evidenceHash(evidence ?? {});
  const required = [
    ["postmaster_report", "reputation_score"],
    ["bounce_metrics", "bounce_pct"],
    ["complaint_metrics", "complaint_pct"],
    ["placement_probe", "inbox_pct"],
  ];

  const missingOrUnsealed = [];
  for (const [name, key] of required) {
    const signal = evidence?.[name];
    if (!signal || signal.sealed !== true || !signal.source || !signal.timestamp || numberAt(signal, key) === null) {
      missingOrUnsealed.push(name);
    }
  }

  const reputation = numberAt(evidence?.postmaster_report, "reputation_score");
  const bounce = numberAt(evidence?.bounce_metrics, "bounce_pct");
  const complaint = numberAt(evidence?.complaint_metrics, "complaint_pct");
  const inbox = numberAt(evidence?.placement_probe, "inbox_pct");
  const minRep = numberAt(policy, "min_reputation_score");
  const maxBounce = numberAt(policy, "max_bounce_pct");
  const maxComplaint = numberAt(policy, "max_complaint_pct");
  const minInbox = Number.isFinite(Number(policy?.min_inbox_pct)) ? Number(policy.min_inbox_pct) : 90;

  const evaluations = [
    signalStatus("postmaster_report", evidence?.postmaster_report, "reputation_score", `>= ${minRep}`, reputation !== null && minRep !== null && reputation >= minRep),
    signalStatus("bounce_metrics", evidence?.bounce_metrics, "bounce_pct", `<= ${maxBounce}`, bounce !== null && maxBounce !== null && bounce <= maxBounce),
    signalStatus("complaint_metrics", evidence?.complaint_metrics, "complaint_pct", `<= ${maxComplaint}`, complaint !== null && maxComplaint !== null && complaint <= maxComplaint),
    signalStatus("placement_probe", evidence?.placement_probe, "inbox_pct", `>= ${minInbox}`, inbox !== null && inbox >= minInbox),
  ];

  if ([minRep, maxBounce, maxComplaint].some((value) => value === null)) {
    return refusal("missing_policy_threshold", "Policy must include min_reputation_score, max_bounce_pct, and max_complaint_pct.", ["policy"], evaluations, hash);
  }
  if (missingOrUnsealed.length > 0) {
    return refusal("partial_or_unsealed_signal_set", "Every signal must be sealed and include source, timestamp, and its metric before fusion.", missingOrUnsealed, evaluations, hash);
  }

  const contradictions = [];
  if (reputation >= minRep + 10 && bounce > maxBounce) contradictions.push("postmaster_report_vs_bounce_metrics");
  if (reputation >= minRep + 10 && complaint > maxComplaint) contradictions.push("postmaster_report_vs_complaint_metrics");
  if (inbox >= minInbox && (bounce > maxBounce * 3 || complaint > maxComplaint * 3)) contradictions.push("placement_probe_vs_negative_rates");
  if (contradictions.length > 0) {
    return refusal("contradictory_signals", "Signals contradict: strong reputation or placement conflicts with out-of-policy negative rates, so no recommendation is emitted.", contradictions, evaluations, hash);
  }

  const healthy = reputation >= minRep && bounce <= maxBounce && complaint <= maxComplaint && inbox >= minInbox;
  let state = "degraded";
  let action = "throttle";
  let confidence = [0.62, 0.78];
  let reason = "One or more signals is outside policy but the evidence is non-contradictory.";

  if (healthy) {
    state = "healthy";
    action = "continue";
    confidence = [0.84, 0.93];
    reason = "All sealed deliverability signals satisfy operator thresholds.";
  } else if (reputation < minRep - 20 || bounce > maxBounce * 3 || complaint > maxComplaint * 3 || inbox < minInbox - 25) {
    state = "unsafe";
    action = "pause";
    confidence = [0.7, 0.86];
    reason = "One or more sealed deliverability signals is materially outside policy.";
  }

  return {
    verdict: {
      state,
      confidence_window: confidence,
      reason,
    },
    recommendation: {
      action,
      signal_bindings: evaluations.map(({ name, source, timestamp, metric, value, policy: policyText, pass }) => ({
        name,
        source,
        timestamp,
        metric,
        value,
        policy: policyText,
        pass,
      })),
      evidence_hash: hash,
      read_only: true,
    },
    escalation: null,
    signal_evaluations: evaluations,
    evidence_hash: hash,
  };
}

function main() {
  const evidence = jsonInput("EVIDENCE", {});
  const policy = jsonInput("POLICY", {});
  const result = judge(evidence, policy);
  const output = {
    schema: "runx.deliverability.verdict.v1",
    package: "deliverability-judge",
    version: "0.1.0",
    verdict: result.verdict,
    recommendation: result.recommendation,
    escalation: result.escalation,
    signal_evaluations: result.signal_evaluations,
    evidence_hash: result.evidence_hash,
    authority: {
      minted: false,
      effects_emitted: false,
      operational_proposal_v1: false,
      attenuation_request: false,
      sends_executed: false,
      throttle_applied: false,
      state_held: false,
    },
    downstream_dispatch_by_name: "future T5 deliverability throttle lane, operated separately",
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

