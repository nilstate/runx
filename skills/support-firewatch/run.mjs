import fs from "node:fs";

const inputs = readInputs();
const thread = arrayValue(inputs.thread, "thread");
const policy = objectValue(inputs.sla_policy, "sla_policy");
if (thread.length === 0) fail("thread must contain at least one turn");

const now = parseTime(stringValue(policy.now) ?? new Date().toISOString(), "sla_policy.now");
const firstResponseDue = numberValue(policy.first_response_due_minutes, 60);
const followupDue = numberValue(policy.followup_due_minutes, firstResponseDue);
const churnTerms = arrayStrings(policy.churn_risk_terms ?? ["cancel", "refund", "churn", "switch vendor"]);
const negativeTerms = arrayStrings(policy.negative_sentiment_terms ?? ["angry", "broken", "down", "urgent", "blocking", "unacceptable"]);

const turns = thread.map(normalizeTurn).sort((a, b) => a.atMs - b.atMs);
const customerTurns = turns.filter((turn) => turn.role === "customer");
const agentTurns = turns.filter((turn) => turn.role === "agent");
const lastCustomer = customerTurns.at(-1) ?? null;
const lastAgent = agentTurns.at(-1) ?? null;
const firstCustomer = customerTurns[0] ?? turns[0];
const lastTurn = turns.at(-1);
const text = normalize(turns.map((turn) => turn.body).join("\n"));
const matchedChurn = matchTerms(text, churnTerms);
const matchedNegative = matchTerms(text, negativeTerms);
const unanswered = lastCustomer && (!lastAgent || lastAgent.atMs < lastCustomer.atMs);
const ageSinceLastCustomer = lastCustomer ? Math.max(0, Math.round((now.getTime() - lastCustomer.atMs) / 60000)) : 0;
const ageSinceFirstCustomer = firstCustomer ? Math.max(0, Math.round((now.getTime() - firstCustomer.atMs) / 60000)) : 0;
const dueMinutes = agentTurns.length === 0 ? firstResponseDue : followupDue;
const slaBreach = Boolean(unanswered && ageSinceLastCustomer > dueMinutes);
const churnRiskLevel = matchedChurn.length >= 1 ? "high" : matchedNegative.length >= 2 ? "medium" : "low";
const sentiment = matchedNegative.length >= 2 || matchedChurn.length > 0 ? "negative" : matchedNegative.length === 1 ? "watch" : "neutral";
const needed = slaBreach || churnRiskLevel === "high";
const priority = needed
  ? (slaBreach && churnRiskLevel === "high" ? "urgent" : churnRiskLevel === "high" ? "high" : "medium")
  : "none";
const reasons = [];
if (slaBreach) reasons.push(`unanswered customer turn is ${ageSinceLastCustomer} minutes old, above ${dueMinutes} minute SLA`);
if (matchedChurn.length) reasons.push(`churn-risk terms matched: ${matchedChurn.join(", ")}`);
if (!needed) reasons.push("thread is within SLA and no high churn-risk terms were found");

const result = {
  signals: {
    sentiment,
    sla_breach: {
      breached: slaBreach,
      due_minutes: dueMinutes,
      age_minutes: ageSinceLastCustomer,
      basis: unanswered ? "last_customer_turn_unanswered" : "agent_replied_after_last_customer",
      evidence_refs: lastCustomer ? [lastCustomer.id] : [],
    },
    churn_risk: {
      level: churnRiskLevel,
      matched_terms: matchedChurn,
      evidence_refs: evidenceRefsForTerms(turns, matchedChurn),
    },
  },
  escalation: {
    needed,
    priority,
    context: {
      reasons,
      evidence_refs: unique([
        ...(lastCustomer ? [lastCustomer.id] : []),
        ...evidenceRefsForTerms(turns, [...matchedChurn, ...matchedNegative]),
      ]),
      last_customer_turn_id: lastCustomer?.id ?? null,
      last_agent_turn_id: lastAgent?.id ?? null,
      last_turn_role: lastTurn?.role ?? null,
      age_since_first_customer_minutes: ageSinceFirstCustomer,
      side_effects: "none",
    },
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {
    thread: parseInput(process.env.RUNX_INPUT_THREAD),
    sla_policy: parseInput(process.env.RUNX_INPUT_SLA_POLICY),
  };
}
function parseInput(raw) {
  if (raw === undefined || raw === "") return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}
function normalizeTurn(turn, index) {
  const item = objectValue(turn, `thread[${index}]`);
  const at = parseTime(stringValue(item.at), `thread[${index}].at`);
  const role = normalizeRole(stringValue(item.role) ?? stringValue(item.author) ?? "unknown");
  const body = stringValue(item.body) ?? stringValue(item.message) ?? "";
  return { id: stringValue(item.id) ?? `turn-${index + 1}`, atMs: at.getTime(), role, body };
}
function normalizeRole(value) {
  const role = normalize(value);
  if (["customer", "user", "requester"].includes(role)) return "customer";
  if (["agent", "support", "operator", "staff"].includes(role)) return "agent";
  return role || "unknown";
}
function evidenceRefsForTerms(turns, terms) {
  if (!terms.length) return [];
  return unique(turns.filter((turn) => terms.some((term) => normalize(turn.body).includes(normalize(term)))).map((turn) => turn.id));
}
function matchTerms(text, terms) {
  return unique(terms.filter((term) => text.includes(normalize(term))));
}
function parseTime(value, name) {
  if (!value) fail(`${name} is required`);
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) fail(`${name} must be an ISO timestamp`);
  return time;
}
function arrayValue(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value;
}
function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function numberValue(value, fallback) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function arrayStrings(value) {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : [];
}
function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}
function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
