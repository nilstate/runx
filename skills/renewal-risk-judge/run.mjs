function jsonInput(name, fallback = undefined) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name.toLowerCase()} must be valid JSON`);
  }
}

function numberMetric(object, key, label) {
  const value = Number(object?.[key]);
  if (!Number.isFinite(value)) {
    return { ok: false, reason: `${label}.${key} is missing or not numeric` };
  }
  return { ok: true, value };
}

function booleanMetric(object, key, label) {
  if (typeof object?.[key] !== "boolean") {
    return { ok: false, reason: `${label}.${key} is missing or not boolean` };
  }
  return { ok: true, value: object[key] };
}

function normalizeTrend(trend) {
  return String(trend ?? "").trim().toLowerCase();
}

function scoreUsage(usageSignals) {
  const trend = normalizeTrend(usageSignals?.trend);
  const mau = numberMetric(usageSignals, "mau_pct_change", "usage_signals");
  if (!trend) return { ok: false, reason: "missing usage_signals.trend" };
  if (!mau.ok) return mau;

  let points = 0;
  const reasons = [];
  if (["declining", "down", "shrinking", "drop"].includes(trend) || mau.value <= -15) {
    points = 45;
    reasons.push(`usage trend=${trend}; mau_pct_change=${mau.value}`);
  } else if (mau.value <= -5) {
    points = 25;
    reasons.push(`mild usage decline mau_pct_change=${mau.value}`);
  } else {
    reasons.push(`usage trend=${trend}; mau_pct_change=${mau.value}`);
  }
  return { ok: true, points, reasons, trend, mau_pct_change: mau.value };
}

function scoreSupport(supportHistory) {
  const volume = numberMetric(supportHistory, "volume", "support_history");
  const severity = numberMetric(supportHistory, "ticket_severity_avg", "support_history");
  const missing = [volume, severity].filter((item) => !item.ok).map((item) => item.reason);
  if (missing.length) return { ok: false, reason: missing.join("; ") };

  let points = 0;
  if (volume.value >= 8 || severity.value >= 3.5) points = 25;
  else if (volume.value >= 3 || severity.value >= 2.5) points = 10;
  return {
    ok: true,
    points,
    reasons: [`support volume=${volume.value}; ticket_severity_avg=${severity.value}`],
    volume: volume.value,
    ticket_severity_avg: severity.value,
  };
}

function scorePayment(paymentSnapshot) {
  const daysLate = numberMetric(paymentSnapshot, "days_late", "payment_snapshot");
  const churnFlag = booleanMetric(paymentSnapshot, "churn_flag", "payment_snapshot");
  const missing = [daysLate, churnFlag].filter((item) => !item.ok).map((item) => item.reason);
  if (missing.length) return { ok: false, reason: missing.join("; ") };
  if (daysLate.value < 0) return { ok: false, reason: "payment_snapshot.days_late cannot be negative" };

  let points = 0;
  if (daysLate.value >= 7 || churnFlag.value) points = 30;
  else if (daysLate.value > 0) points = 15;
  return {
    ok: true,
    points,
    reasons: [`payment days_late=${daysLate.value}; churn_flag=${churnFlag.value}`],
    days_late: daysLate.value,
    churn_flag: churnFlag.value,
  };
}

function riskLevel(score) {
  if (score > 100) return "critical";
  if (score >= 65) return "high";
  if (score >= 35) return "moderate";
  return "low";
}

function stop(reason, signals) {
  return {
    schema: "runx.support.renewal_risk.v1",
    package: "renewal-risk-judge",
    version: "0.1.0",
    decision: {
      risk_level: "stop",
      justification: reason,
    },
    fused_score: null,
    signal_weights: {
      usage_trend: 45,
      support: 25,
      payment: 30,
    },
    signal_evidence: signals,
    escalation: {
      lane: "support.renewal_risk.human_approval",
      reason,
      send_as_allowed_without_approval: false,
    },
    save_plan: null,
    refused: true,
    effects: {
      send: false,
      money_rail: false,
      discount_apply: false,
      price_quote: false,
      operational_proposal: false,
    },
  };
}

function evaluate({ usageSignals, supportHistory, paymentSnapshot }) {
  const usage = scoreUsage(usageSignals);
  const support = scoreSupport(supportHistory);
  const payment = scorePayment(paymentSnapshot);
  const signalEvidence = {
    usage_signals: usage.ok ? {
      trend: usage.trend,
      mau_pct_change: usage.mau_pct_change,
      points: usage.points,
      reasons: usage.reasons,
    } : { error: usage.reason },
    support_history: support.ok ? {
      volume: support.volume,
      ticket_severity_avg: support.ticket_severity_avg,
      points: support.points,
      reasons: support.reasons,
    } : { error: support.reason },
    payment_snapshot: payment.ok ? {
      days_late: payment.days_late,
      churn_flag: payment.churn_flag,
      points: payment.points,
      reasons: payment.reasons,
    } : { error: payment.reason },
  };

  for (const signal of [usage, support, payment]) {
    if (!signal.ok) return stop(signal.reason, signalEvidence);
  }

  const usageDeclines = usage.points >= 45;
  const paymentShowsNoRisk = payment.days_late === 0 && payment.churn_flag === false;
  if (usageDeclines && paymentShowsNoRisk) {
    return stop("contradictory signals: usage decline conflicts with payment snapshot showing no renewal risk", signalEvidence);
  }

  const fusedScore = usage.points + support.points + payment.points;
  const level = riskLevel(fusedScore);
  const highOrCritical = ["high", "critical"].includes(level);
  const moderate = level === "moderate";
  const justification = [
    `usage=${usage.points}/45`,
    `support=${support.points}/25`,
    `payment=${payment.points}/30`,
    `fused_score=${fusedScore}`,
  ].join("; ");

  return {
    schema: "runx.support.renewal_risk.v1",
    package: "renewal-risk-judge",
    version: "0.1.0",
    decision: {
      risk_level: level,
      justification,
    },
    fused_score: fusedScore,
    signal_weights: {
      usage_trend: 45,
      support: 25,
      payment: 30,
    },
    signal_evidence: signalEvidence,
    escalation: highOrCritical
      ? {
          lane: "support.renewal_risk.human_approval",
          reason: "high_or_critical_renewal_risk_requires_human_approval_before_send_as",
          send_as_allowed_without_approval: false,
        }
      : moderate
        ? {
            lane: "support.renewal_risk.human_approval",
            reason: "moderate_edge_case_requires_human_review",
            send_as_allowed_without_approval: false,
          }
        : {
            lane: null,
            reason: "low_risk_no_save_plan",
            send_as_allowed_without_approval: false,
          },
    save_plan: highOrCritical
      ? {
          channel: "email",
          audience: "account_owner_and_success_manager",
          content_ref: "content://renewal-save/high-risk-usage-support-payment-v1",
        }
      : null,
    refused: false,
    dispatch_by_name: {
      verdict_name: "runx.support.renewal_risk.v1",
      downstream: "send-as",
      delivery_rule: "separate governed send-as run may deliver only after human approval",
    },
    effects: {
      send: false,
      money_rail: false,
      discount_apply: false,
      price_quote: false,
      operational_proposal: false,
    },
  };
}

function main() {
  const usageSignals = jsonInput("USAGE_SIGNALS", {});
  const supportHistory = jsonInput("SUPPORT_HISTORY", {});
  const paymentSnapshot = jsonInput("PAYMENT_SNAPSHOT", {});
  const output = evaluate({ usageSignals, supportHistory, paymentSnapshot });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
