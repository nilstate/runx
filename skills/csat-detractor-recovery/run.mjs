import fs from "node:fs";

const inputs = readInputs();
const feedback = stringValue(inputs.feedback);
const csatRaw = inputs.csat_score;
const accountTier = stringValue(inputs.account_tier) ?? "";
const ltvRaw = inputs.lifetime_value_usd;
const priorRaw = inputs.prior_complaints;

if (!feedback) fail("feedback is required and must be non-empty");
const csat = numberValue(csatRaw, "csat_score");
if (csat < 0 || csat > 10) fail("csat_score must be between 0 and 10");
const ltv = ltvRaw === undefined ? 0 : numberValue(ltvRaw, "lifetime_value_usd");
const prior = priorRaw === undefined ? 0 : numberValue(priorRaw, "prior_complaints");

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const FEEDBACK_KEYWORDS = {
  product: ["bug", "broken", "crash", "error", "feature", "ui", "ux"],
  price: ["price", "pricing", "expensive", "cost", "value", "billing"],
  support: ["support", "response", "agent", "help", "service"],
  other: [],
};

const classification = classifyFeedback(feedback);
const severity = pickSeverity(csat, ltv);
const recommendedPath = pickPath(severity, prior);
const ownerRole = pickOwnerRole(accountTier, severity);
const stopConditions = pickStopConditions(severity);
const rationale = `score=${csat}; ltv_usd=${ltv}; prior_complaints=${prior}; matched_signals=${classification.matched_signals.join(",")}; account_tier=${accountTier || "unknown"}`;
const handoff = {
  next_skill: "governed-outbound",
  requires_human_approval: true,
};

const result = {
  severity,
  classification: classification.label,
  recommended_path: recommendedPath,
  rationale,
  owner_role: ownerRole,
  stop_conditions: stopConditions,
  handoff,
  meta: {
    feedback_length: feedback.length,
    feedback_truncated: feedback.length > 280,
    csat_score: csat,
    lifetime_value_usd: ltv,
    prior_complaints: prior,
    account_tier: accountTier || null,
    matched_signals: classification.matched_signals,
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
    feedback: parseInputValue(process.env.RUNX_INPUT_FEEDBACK),
    csat_score: parseInputValue(process.env.RUNX_INPUT_CSAT_SCORE),
    account_tier: parseInputValue(process.env.RUNX_INPUT_ACCOUNT_TIER),
    lifetime_value_usd: parseInputValue(process.env.RUNX_INPUT_LIFETIME_VALUE_USD),
    prior_complaints: parseInputValue(process.env.RUNX_INPUT_PRIOR_COMPLAINTS),
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
  process.stdout.write(`${JSON.stringify({ error: "csat_recovery_invalid_input", detail: reason }, null, 2)}\n`);
  process.exit(64);
}

function classifyFeedback(text) {
  const lower = text.toLowerCase();
  const matched = [];
  let label = "other";
  let firstCount = 0;
  for (const [name, keywords] of Object.entries(FEEDBACK_KEYWORDS)) {
    const hits = keywords.filter((kw) => lower.includes(kw)).length;
    if (hits > firstCount) { firstCount = hits; label = name; }
    matched.push(...keywords.filter((kw) => lower.includes(kw)));
  }
  const unique = Array.from(new Set(matched));
  return { label, matched_signals: unique };
}

function pickSeverity(score, ltv) {
  if (score <= 2 && ltv >= 1000) return "critical";
  if (score <= 4) return "high";
  if (score <= 6) return "medium";
  return "low";
}

function pickPath(severity, priorComplaints) {
  if (severity === "critical") return "escalate";
  if (severity === "high") return "credit";
  if (severity === "medium") return "outreach";
  return "apology_only";
}

function pickOwnerRole(tier, severity) {
  if (severity === "critical") return "founder";
  if (tier === "enterprise" || tier === "growth") return "csm_lead";
  if (severity === "high") return "cs_manager";
  return "support_lead";
}

function pickStopConditions(severity) {
  const conditions = ["no_resolution_within_72h"];
  if (severity === "critical" || severity === "high") {
    conditions.push("customer_requests_refund_or_cancel");
  }
  if (severity === "critical") {
    conditions.push("escalation_to_legal_or_compliance");
  }
  return conditions;
}