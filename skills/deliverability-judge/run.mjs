// deliverability-judge: read sealed sending-posture evidence (postmaster
// reputation, bounce metrics, complaint metrics, placement probe) against
// operator policy thresholds, fuse the signals into one verdict with a
// confidence window, and recommend continue / throttle / pause. Read-only
// SHAPE-A: mints no authority, holds no state, emits no Effect. When signals
// contradict, are unsealed, or are too thin to support a call, it emits an
// escalation record instead of a verdict and never guesses. Exit 0 seals a
// run (verdict or escalation are both sealed outcomes); exit 64 refuses
// malformed input.

const EXIT_USAGE = 64;

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function readJsonInput(name) {
  const raw = process.env[`RUNX_INPUT_${name.toUpperCase()}`];
  if (raw === undefined || raw.trim() === "") {
    fail(EXIT_USAGE, `${name} is required`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(EXIT_USAGE, `${name} is not valid JSON`);
  }
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// --- Sealing --------------------------------------------------------------
// A signal is sealed when it names its source and carries a parseable
// timestamp. Unsealed signals are never evaluated; they are named in an
// escalation. The judge never substitutes a value for a signal it cannot
// find sealed in the evidence.

const SIGNAL_NAMES = [
  "postmaster_report",
  "bounce_metrics",
  "complaint_metrics",
  "placement_probe",
];

function sealState(signal) {
  if (!isObject(signal)) return "missing";
  if (typeof signal.source !== "string" || signal.source.trim() === "") {
    return "unsealed: no source";
  }
  if (typeof signal.timestamp !== "string" || Number.isNaN(Date.parse(signal.timestamp))) {
    return "unsealed: no parseable timestamp";
  }
  return "sealed";
}

// --- Per-signal evaluation --------------------------------------------------
// Each evaluation carries a normalized health score in [0, 1] (1 = far on the
// healthy side of the policy threshold, 0 = far on the failing side, 0.5 = at
// the threshold) and an uncertainty half-width. Rate signals built from raw
// counts get a Wilson 95% interval, so a 2% bounce rate over 50 sends is wide
// and honest while the same rate over 50,000 sends is tight. Signals reported
// as bare rates without denominators carry a fixed penalty width.

const Z = 1.959964; // 95%
const BARE_RATE_UNCERTAINTY = 0.2;
const POINT_SCORE_UNCERTAINTY = 0.05;

function wilson(successes, trials) {
  if (trials <= 0) return { center: 0, halfWidth: 0.5 };
  const p = successes / trials;
  const z2 = Z * Z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const halfWidth =
    (Z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  return { center, halfWidth };
}

// Map a measured rate against a threshold into a health score. `direction`
// is "below" when healthy means measured <= threshold (bounce, complaint) and
// "above" when healthy means measured >= threshold (reputation, inbox rate).
// The scale is the threshold itself, so "twice the allowed bounce rate" and
// "half the required reputation" land equally deep in failing territory.
function healthScore(measured, threshold, direction, scale) {
  const span = Math.max(scale, 1e-9);
  const distance =
    direction === "below" ? (threshold - measured) / span : (measured - threshold) / span;
  return Math.min(1, Math.max(0, 0.5 + distance / 2));
}

function classify(score, uncertainty) {
  const lo = score - uncertainty;
  const hi = score + uncertainty;
  if (lo > 0.5) return "pass";
  if (hi < 0.5) return "fail";
  return "warn";
}

function strength(score, uncertainty, status) {
  if (status === "pass" && score - uncertainty >= 0.7) return "strong-good";
  if (status === "fail" && score + uncertainty <= 0.3) return "strong-bad";
  return "weak";
}

function evaluatePostmaster(signal, policy) {
  if (!isFiniteNumber(signal.reputation_score)) {
    return { invalid: "postmaster_report.reputation_score must be a number" };
  }
  const threshold = policy.min_reputation_score;
  const score = healthScore(signal.reputation_score, threshold, "above", 100 - threshold || 1);
  return {
    signal: "postmaster_report",
    measured: `reputation_score ${signal.reputation_score}`,
    threshold: `min_reputation_score ${threshold}`,
    score,
    uncertainty: POINT_SCORE_UNCERTAINTY,
    source: signal.source,
    timestamp: signal.timestamp,
  };
}

function evaluateRate(signal, name, numeratorKey, denominatorKey, rateKey, threshold, thresholdLabel, direction) {
  let ratePct;
  let uncertainty;
  const hasCounts =
    isFiniteNumber(signal[numeratorKey]) && isFiniteNumber(signal[denominatorKey]);
  if (hasCounts) {
    if (signal[denominatorKey] <= 0) {
      return {
        thin: `${name}: ${denominatorKey} is ${signal[denominatorKey]}; no volume to judge`,
      };
    }
    const w = wilson(signal[numeratorKey], signal[denominatorKey]);
    ratePct = (signal[numeratorKey] / signal[denominatorKey]) * 100;
    // Wilson half-width is on the proportion; project it through the same
    // threshold scale used by healthScore so tight samples stay tight.
    uncertainty = Math.min(0.5, (w.halfWidth * 100) / Math.max(threshold, 1e-9) / 2);
  } else if (isFiniteNumber(signal[rateKey])) {
    ratePct = signal[rateKey];
    uncertainty = BARE_RATE_UNCERTAINTY;
  } else {
    return {
      invalid: `${name} needs ${numeratorKey}+${denominatorKey} counts or ${rateKey}`,
    };
  }
  const score = healthScore(ratePct, threshold, direction, threshold);
  return {
    signal: name,
    measured: `${rateKey} ${Number(ratePct.toFixed(4))}%${hasCounts ? ` (${signal[numeratorKey]}/${signal[denominatorKey]})` : " (no denominator reported)"}`,
    threshold: `${thresholdLabel} ${threshold}%`,
    score,
    uncertainty,
    source: signal.source,
    timestamp: signal.timestamp,
  };
}

function evaluatePlacement(signal, policy) {
  const minInbox = isFiniteNumber(policy.min_inbox_rate_pct) ? policy.min_inbox_rate_pct : 80;
  return evaluateRate(
    signal,
    "placement_probe",
    "inbox",
    "seeds",
    "inbox_rate_pct",
    minInbox,
    "min_inbox_rate_pct",
    "above"
  );
}

// --- Fusion -----------------------------------------------------------------

function sha256Hex(text) {
  return import("node:crypto").then(({ createHash }) =>
    createHash("sha256").update(text).digest("hex")
  );
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function escalate(reason, details, evaluations) {
  return {
    escalation: {
      kind: "deliverability_escalation",
      reason,
      ...details,
      signal_evaluations: evaluations,
      next_step:
        "human deliverability review; no recommendation is issued and nothing downstream is throttled or paused by this run",
    },
  };
}

async function main() {
  const evidence = readJsonInput("evidence");
  const policy = readJsonInput("policy");

  if (!isObject(evidence)) fail(EXIT_USAGE, "evidence must be a JSON object");
  if (!isObject(policy)) fail(EXIT_USAGE, "policy must be a JSON object");
  for (const key of ["min_reputation_score", "max_bounce_pct", "max_complaint_pct"]) {
    if (!isFiniteNumber(policy[key])) {
      fail(EXIT_USAGE, `policy.${key} is required and must be a number`);
    }
  }

  // 1. Sealing gate: every signal must be present, sourced, and timestamped.
  const sealProblems = [];
  for (const name of SIGNAL_NAMES) {
    const state = sealState(evidence[name]);
    if (state !== "sealed") sealProblems.push({ signal: name, problem: state });
  }
  if (sealProblems.length > 0) {
    const output = escalate(
      "partial or unsealed signal set: a verdict needs all four signals sealed with source and timestamp",
      {
        missing_or_unsealed: sealProblems,
        sealed_signals: SIGNAL_NAMES.filter(
          (n) => !sealProblems.some((p) => p.signal === n)
        ),
      },
      []
    );
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return;
  }

  // 2. Per-signal evaluation against policy.
  const rawEvals = [
    evaluatePostmaster(evidence.postmaster_report, policy),
    evaluateRate(
      evidence.bounce_metrics,
      "bounce_metrics",
      "bounces",
      "sends",
      "bounce_rate_pct",
      policy.max_bounce_pct,
      "max_bounce_pct",
      "below"
    ),
    evaluateRate(
      evidence.complaint_metrics,
      "complaint_metrics",
      "complaints",
      "delivered",
      "complaint_rate_pct",
      policy.max_complaint_pct,
      "max_complaint_pct",
      "below"
    ),
    evaluatePlacement(evidence.placement_probe, policy),
  ];

  const invalid = rawEvals.filter((e) => e.invalid).map((e) => e.invalid);
  if (invalid.length > 0) fail(EXIT_USAGE, invalid.join("; "));

  const thin = rawEvals.filter((e) => e.thin).map((e) => e.thin);
  const evaluations = rawEvals
    .filter((e) => e.signal)
    .map((e) => {
      const status = classify(e.score, e.uncertainty);
      return { ...e, status, strength: strength(e.score, e.uncertainty, status) };
    });

  if (thin.length > 0) {
    const output = escalate(
      "evidence too thin to judge: a signal reports no measurable volume",
      { thin_signals: thin },
      evaluations
    );
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return;
  }

  // 3. Contradiction gate: a strongly healthy signal against a strongly
  // failing one means the evidence disagrees with itself (stale report,
  // wrong stream, list poisoning). Fusing that into an average would
  // manufacture confidence neither signal supports, so the judge refuses.
  const strongGood = evaluations.filter((e) => e.strength === "strong-good");
  const strongBad = evaluations.filter((e) => e.strength === "strong-bad");
  if (strongGood.length > 0 && strongBad.length > 0) {
    const output = escalate(
      "contradictory signals: strongly healthy and strongly failing evidence cannot be fused into one verdict",
      {
        contradicting_signals: {
          healthy_side: strongGood.map((e) => `${e.signal} (${e.measured})`),
          failing_side: strongBad.map((e) => `${e.signal} (${e.measured})`),
        },
      },
      evaluations
    );
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return;
  }

  // 4. Fusion: weakest-link state, evidence-weighted confidence window.
  const fusedScore =
    evaluations.reduce((acc, e) => acc + e.score, 0) / evaluations.length;
  const windowHalf = Math.sqrt(
    evaluations.reduce((acc, e) => acc + e.uncertainty * e.uncertainty, 0) /
      evaluations.length
  );
  const confidenceWindow = [
    Number(Math.max(0, fusedScore - windowHalf).toFixed(3)),
    Number(Math.min(1, fusedScore + windowHalf).toFixed(3)),
  ];

  const maxWindow = isFiniteNumber(policy.max_confidence_window)
    ? policy.max_confidence_window
    : 0.5;
  if (confidenceWindow[1] - confidenceWindow[0] > maxWindow) {
    const output = escalate(
      "confidence window too wide to support a verdict: the sealed evidence is individually valid but collectively too uncertain",
      { confidence_window: confidenceWindow, max_confidence_window: maxWindow },
      evaluations
    );
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return;
  }

  const failing = evaluations.filter((e) => e.status === "fail");
  const warning = evaluations.filter((e) => e.status === "warn");

  let state;
  let action;
  let reason;
  if (failing.length >= 2) {
    state = "at_risk";
    action = "pause";
    reason = `multiple signals breach policy: ${failing.map((e) => e.signal).join(", ")}`;
  } else if (failing.length === 1) {
    state = "degraded";
    action = "throttle";
    reason = `${failing[0].signal} breaches policy (${failing[0].measured} vs ${failing[0].threshold}) while the remaining signals hold`;
  } else if (warning.length > 0) {
    state = "degraded";
    action = "throttle";
    reason = `no signal breaches policy but ${warning.map((e) => e.signal).join(", ")} sit${warning.length === 1 ? "s" : ""} inside the uncertainty band of the threshold`;
  } else {
    state = "healthy";
    action = "continue";
    reason = "all four sealed signals clear their policy thresholds with margin";
  }

  const evidenceHash = await sha256Hex(canonical(evidence));

  const output = {
    verdict: {
      state,
      confidence_window: confidenceWindow,
      reason,
    },
    recommendation: {
      action,
      read_only: true,
      signal_bindings: evaluations.map((e) => ({
        signal: e.signal,
        source: e.source,
        timestamp: e.timestamp,
        measured: e.measured,
        threshold: e.threshold,
        status: e.status,
      })),
      evidence_hash: `sha256:${evidenceHash}`,
    },
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

await main();
