import fs from "node:fs";

const inputs = readInputs();
const usageSignals = objectValue(inputs.usage_signals, "usage_signals");
const supportHistory = objectValue(inputs.support_history, "support_history");
const paymentSnapshot = objectValue(inputs.payment_snapshot, "payment_snapshot");

const usageTrend = stringValue(usageSignals.trend);
const mauPctChange = numberValue(usageSignals.mau_pct_change);
const supportVolume = numberValue(supportHistory.volume);
const ticketSeverityAvg = numberValue(supportHistory.ticket_severity_avg);
const daysLate = numberValue(paymentSnapshot.days_late);
const churnFlag = booleanValue(paymentSnapshot.churn_flag);
const accountRef = stringValue(inputs.account_ref) || "account:bounded-fixture";

const refusedReasons = [];
if (!usageTrend) refusedReasons.push("usage_signals.trend is required");
if (!Number.isFinite(mauPctChange)) refusedReasons.push("usage_signals.mau_pct_change is required");
if (!Number.isFinite(supportVolume)) refusedReasons.push("support_history.volume is required");
if (!Number.isFinite(ticketSeverityAvg)) refusedReasons.push("support_history.ticket_severity_avg is required");
if (!Number.isFinite(daysLate)) refusedReasons.push("payment_snapshot.days_late is required");
if (typeof churnFlag !== "boolean") refusedReasons.push("payment_snapshot.churn_flag is required");

const usageDecline = usageTrend === "declining" || mauPctChange <= -15;
const paymentRisk = daysLate > 0 || churnFlag === true;
if (refusedReasons.length === 0 && usageDecline && !paymentRisk) {
  refusedReasons.push("contradictory signals: usage declines while payment_snapshot shows no lateness and no churn risk");
}

if (refusedReasons.length > 0) {
  emit({
    packet_schema: "runx.support.renewal_risk.v1",
    decision: {
      risk_level: "refused",
      justification: refusedReasons.join("; "),
      fused_score: null,
      signal_weights: signalWeights({ usage: null, support: null, payment: null }),
    },
    escalation: {
      lane: "human_approval",
      reason: refusedReasons.join("; "),
      dispatch_by_naming: false,
    },
    save_plan: null,
    authority_boundary: boundary(),
  });
}

const usageScore = scoreUsage(usageTrend, mauPctChange);
const supportScore = scoreSupport(supportVolume, ticketSeverityAvg);
const paymentScore = scorePayment(daysLate, churnFlag);
const fusedScore = round2((usageScore * 0.45) + (supportScore * 0.25) + (paymentScore * 0.30));
const riskLevel = riskLevelFor(fusedScore);
const highRisk = riskLevel === "high" || riskLevel === "critical";

const decision = {
  risk_level: riskLevel,
  justification: [
    `usage ${usageTrend} with mau_pct_change=${mauPctChange}`,
    `support volume=${supportVolume}, severity_avg=${ticketSeverityAvg}`,
    `payment days_late=${daysLate}, churn_flag=${churnFlag}`,
    `fused_score=${fusedScore}`,
  ].join("; "),
  fused_score: fusedScore,
  signal_weights: signalWeights({
    usage: usageScore,
    support: supportScore,
    payment: paymentScore,
  }),
};

const savePlan = highRisk ? {
  channel: "email",
  audience: accountRef,
  content_ref: `renewal-save-play:${accountRef}:risk-${riskLevel}`,
  note: "Recommendation only. A separate governed send-as run must bind message content and receive human approval before delivery.",
} : null;

emit({
  packet_schema: "runx.support.renewal_risk.v1",
  decision,
  escalation: highRisk
    ? {
        lane: "retention_owner",
        reason: "high renewal risk merits a bounded save plan recommendation",
        dispatch_by_naming: true,
        downstream_skill: "send-as",
        requires_human_approval: true,
      }
    : {
        lane: "human_approval",
        reason: "moderate or edge-case accounts require human review before any send-as run",
        dispatch_by_naming: false,
        downstream_skill: null,
        requires_human_approval: true,
      },
  save_plan: savePlan,
  authority_boundary: boundary(),
});

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    account_ref: process.env.RUNX_INPUT_ACCOUNT_REF,
    usage_signals: parseInputValue(process.env.RUNX_INPUT_USAGE_SIGNALS),
    support_history: parseInputValue(process.env.RUNX_INPUT_SUPPORT_HISTORY),
    payment_snapshot: parseInputValue(process.env.RUNX_INPUT_PAYMENT_SNAPSHOT),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function objectValue(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return NaN;
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return null;
}

function scoreUsage(trend, pctChange) {
  let score = 0;
  if (trend === "declining") score += 0.55;
  if (trend === "flat") score += 0.25;
  if (pctChange <= -40) score += 0.45;
  else if (pctChange <= -25) score += 0.35;
  else if (pctChange <= -15) score += 0.25;
  return Math.min(1, score);
}

function scoreSupport(volume, severity) {
  const volumeScore = volume >= 12 ? 0.55 : volume >= 6 ? 0.35 : volume >= 3 ? 0.20 : 0;
  const severityScore = severity >= 4 ? 0.45 : severity >= 3 ? 0.30 : severity >= 2 ? 0.15 : 0;
  return Math.min(1, volumeScore + severityScore);
}

function scorePayment(late, churn) {
  let score = churn ? 0.45 : 0;
  if (late >= 30) score += 0.55;
  else if (late >= 14) score += 0.40;
  else if (late > 0) score += 0.25;
  return Math.min(1, score);
}

function riskLevelFor(score) {
  if (score >= 0.85) return "critical";
  if (score >= 0.60) return "high";
  if (score >= 0.35) return "moderate";
  return "low";
}

function signalWeights(scores) {
  return {
    usage_trend: { weight: 0.45, score: scores.usage },
    support: { weight: 0.25, score: scores.support },
    payment: { weight: 0.30, score: scores.payment },
  };
}

function boundary() {
  return {
    recommendation_not_effect: true,
    sends_messages: false,
    mints_authority: false,
    includes_amount_currency_or_counterparty: false,
    downstream_send_requires_governed_send_as_and_human_approval: true,
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(0);
}
