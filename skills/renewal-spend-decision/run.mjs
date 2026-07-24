import fs from "node:fs";

const inputs = readInputs();
const vendor = stringValue(inputs.vendor);
const currentSpend = numberValue(inputs.current_spend_usd, "current_spend_usd");
const renewalDate = stringValue(inputs.renewal_date);
const usageSignals = Array.isArray(inputs.usage_signals) ? inputs.usage_signals : [];
const altOptions = Array.isArray(inputs.alternative_options) ? inputs.alternative_options : [];
const satisfactionHint = stringValue(inputs.satisfaction_hint) ?? "";
const strategicValue = stringValue(inputs.strategic_value) ?? "";

if (!vendor) fail("vendor is required and must be non-empty");
if (!renewalDate) fail("renewal_date is required");
if (currentSpend < 0) fail("current_spend_usd must be >= 0");

const recommendation = pickRecommendation(satisfactionHint, usageSignals, altOptions);
const alternativeSummary = altOptions.map((opt) => ({
  name: String(opt.name || "unknown"),
  est_spend_usd: Number(opt.est_spend_usd || 0),
  pros_count: Array.isArray(opt.pros) ? opt.pros.length : 0,
  cons_count: Array.isArray(opt.cons) ? opt.cons.length : 0,
}));

const confidence = computeConfidence({
  satisfactionHint,
  usageSignalsPresent: usageSignals.length > 0,
  altOptionsPresent: altOptions.length > 0,
  strategicValue,
});

const rationale = buildRationale({
  vendor,
  satisfactionHint,
  usageSignalsPresent: usageSignals.length > 0,
  altOptionsPresent: altOptions.length > 0,
  strategicValue,
  currentSpend,
});

const stopConditions = pickStopConditions(currentSpend, strategicValue, satisfactionHint);
const handoff = {
  next_skill: "governed-outbound",
  requires_human_approval: true,
};

const result = {
  recommendation,
  confidence,
  rationale,
  alternative_options_summary: alternativeSummary,
  stop_conditions: stopConditions,
  handoff,
  meta: {
    vendor,
    current_spend_usd: currentSpend,
    renewal_date: renewalDate,
    satisfaction_hint: satisfactionHint || null,
    strategic_value: strategicValue || null,
    usage_signal_count: usageSignals.length,
    alternative_option_count: altOptions.length,
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    vendor: parseInputValue(process.env.RUNX_INPUT_VENDOR),
    current_spend_usd: parseInputValue(process.env.RUNX_INPUT_CURRENT_SPEND_USD),
    renewal_date: parseInputValue(process.env.RUNX_INPUT_RENEWAL_DATE),
    usage_signals: parseInputValue(process.env.RUNX_INPUT_USAGE_SIGNALS),
    alternative_options: parseInputValue(process.env.RUNX_INPUT_ALTERNATIVE_OPTIONS),
    satisfaction_hint: parseInputValue(process.env.RUNX_INPUT_SATISFACTION_HINT),
    strategic_value: parseInputValue(process.env.RUNX_INPUT_STRATEGIC_VALUE),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function stringValue(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.trim();
  return String(v);
}

function numberValue(v, name) {
  const n = Number(v);
  if (Number.isNaN(n)) fail(`${name} must be a number`);
  return n;
}

function fail(reason) {
  process.stdout.write(`${JSON.stringify({ error: "renewal_decision_invalid_input", detail: reason }, null, 2)}\n`);
  process.exit(64);
}

function pickRecommendation(satisfaction, usage, alts) {
  const hasAlt = alts.length > 0;
  const hasUsage = usage.length > 0;
  if (satisfaction === "low") {
    return hasAlt ? "replace" : "renegotiate";
  }
  if (satisfaction === "medium" && hasUsage) return "renew";
  if (satisfaction === "high") return "renew";
  return "renegotiate";
}

function computeConfidence(ctx) {
  let c = 0.5;
  if (ctx.satisfactionHint) c += 0.15;
  if (ctx.usageSignalsPresent) c += 0.15;
  if (ctx.altOptionsPresent) c += 0.1;
  if (ctx.strategicValue === "high") c -= 0.1;
  if (ctx.strategicValue === "low") c += 0.05;
  return Math.max(0.3, Math.min(0.95, Number(c.toFixed(2))));
}

function buildRationale(ctx) {
  const parts = [
    `vendor=${ctx.vendor}`,
    `satisfaction_hint=${ctx.satisfactionHint || "none"}`,
    `usage_signals_present=${ctx.usageSignalsPresent}`,
    `alternative_options_present=${ctx.altOptionsPresent}`,
    `strategic_value=${ctx.strategicValue || "none"}`,
    `current_spend_usd=${ctx.currentSpend}`,
  ];
  return parts.join(";");
}

function pickStopConditions(currentSpend, strategicValue, satisfaction) {
  const conditions = [];
  if (currentSpend >= 5000) conditions.push("spend_above_threshold_requires_finance_lead");
  if (strategicValue === "high") conditions.push("strategic_vendor_requires_executive_signoff");
  if (satisfaction === "low") conditions.push("churn_risk_requires_success_team_review");
  return conditions;
}