import fs from "node:fs";

const inputs = readInputs();
const thread = arrayValue(inputs.thread, "thread");
const policy = objectValue(inputs.sla_policy, "sla_policy");

const now = parseDate(policy.now, "sla_policy.now");
const firstResponseMinutes = positiveNumber(policy.first_response_minutes, "sla_policy.first_response_minutes");
const nextResponseMinutes = positiveNumber(policy.next_response_minutes, "sla_policy.next_response_minutes");

const turns = thread.map(normalizeTurn);
if (turns.length === 0) {
  fail("thread must contain at least one turn");
}

const customerTurns = turns.filter((turn) => turn.role === "customer");
if (customerTurns.length === 0) {
  fail("thread must contain at least one customer turn");
}

const sentiment = sentimentSignal(customerTurns);
const slaBreach = slaBreachSignal(turns, now, firstResponseMinutes, nextResponseMinutes);
const churnRisk = churnRiskSignal(customerTurns);
const escalation = escalationDecision({ sentiment, slaBreach, churnRisk });

process.stdout.write(JSON.stringify({
  signals: {
    sentiment,
    sla_breach: slaBreach,
    churn_risk: churnRisk,
  },
  escalation,
}, null, 2));
process.stdout.write("\n");

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    thread: parseInputValue(process.env.RUNX_INPUT_THREAD),
    sla_policy: parseInputValue(process.env.RUNX_INPUT_SLA_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeTurn(turn, index) {
  const item = objectValue(turn, `thread[${index}]`);
  const body = stringValue(item.body, `thread[${index}].body`);
  const timestamp = parseDate(item.timestamp, `thread[${index}].timestamp`);
  const rawRole = stringValue(item.role ?? item.kind ?? item.author_role, `thread[${index}].role`).toLowerCase();
  const role = ["customer", "user", "requester"].includes(rawRole) ? "customer" : "agent";
  return {
    id: stringOptional(item.id) ?? `turn-${index + 1}`,
    role,
    author: stringOptional(item.author) ?? role,
    timestamp,
    body,
    normalized: normalizeText(body),
  };
}

function sentimentSignal(customerTurns) {
  const negativeWords = ["angry", "unacceptable", "ignored", "broken", "outage", "failed", "cancel", "refund", "terrible", "escalate"];
  const positiveWords = ["thanks", "great", "good", "resolved", "worked", "appreciate"];
  const negativeEvidence = evidenceForWords(customerTurns, negativeWords);
  const positiveEvidence = evidenceForWords(customerTurns, positiveWords);
  const score = clamp((positiveEvidence.length * 0.3) - (negativeEvidence.length * 0.35), -1, 1);
  const label = score <= -0.35 ? "negative" : score >= 0.35 ? "positive" : "neutral";
  return {
    label,
    score: Number(score.toFixed(2)),
    evidence: label === "negative" ? negativeEvidence : positiveEvidence,
  };
}

function slaBreachSignal(turns, now, firstResponseMinutes, nextResponseMinutes) {
  const latestCustomer = [...turns].reverse().find((turn) => turn.role === "customer");
  const hasPriorAgent = turns.some((turn) => turn.role === "agent" && turn.timestamp < latestCustomer.timestamp);
  const threshold = hasPriorAgent ? nextResponseMinutes : firstResponseMinutes;
  const elapsed = Math.floor((now.getTime() - latestCustomer.timestamp.getTime()) / 60000);
  const breached = elapsed > threshold;
  return {
    breached,
    elapsed_minutes: elapsed,
    threshold_minutes: threshold,
    evidence: {
      turn_id: latestCustomer.id,
      turn_timestamp: latestCustomer.timestamp.toISOString(),
      policy_clock: now.toISOString(),
      policy: hasPriorAgent ? "next_response_minutes" : "first_response_minutes",
    },
  };
}

function churnRiskSignal(customerTurns) {
  const highRiskWords = ["cancel", "refund", "legal", "lawyer", "chargeback", "tweet", "linkedin", "competitor"];
  const mediumRiskWords = ["unacceptable", "ignored", "angry", "escalate", "manager", "outage"];
  const high = evidenceForWords(customerTurns, highRiskWords);
  const medium = evidenceForWords(customerTurns, mediumRiskWords);
  const level = high.length > 0 ? "high" : medium.length > 0 ? "medium" : "low";
  return {
    level,
    evidence: high.length > 0 ? high : medium,
  };
}

function escalationDecision({ sentiment, slaBreach, churnRisk }) {
  const reasons = [];
  if (slaBreach.breached) reasons.push(`SLA breach: ${slaBreach.elapsed_minutes} minutes elapsed against ${slaBreach.threshold_minutes} minute policy`);
  if (sentiment.label === "negative") reasons.push("negative customer sentiment grounded in thread text");
  if (churnRisk.level === "high") reasons.push("high churn-risk language present");
  const needed = reasons.length > 0;
  return {
    needed,
    priority: churnRisk.level === "high" || (needed && slaBreach.breached) ? "urgent" : needed ? "normal" : null,
    context: {
      reason: needed ? reasons.join("; ") : "No SLA breach, strong negative sentiment, or churn-risk signal found in the supplied thread.",
      approval_inbox: "human_support_escalation",
      no_side_effects: true,
    },
  };
}

function evidenceForWords(turns, words) {
  const evidence = [];
  for (const turn of turns) {
    const matched = words.filter((word) => turn.normalized.includes(word));
    if (matched.length > 0) {
      evidence.push({
        turn_id: turn.id,
        author: turn.author,
        timestamp: turn.timestamp.toISOString(),
        matched,
        excerpt: excerpt(turn.body),
      });
    }
  }
  return evidence;
}

function arrayValue(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value;
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) fail(`${name} must be a positive number`);
  return number;
}

function parseDate(value, name) {
  const raw = stringValue(value, name);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) fail(`${name} must be an ISO timestamp`);
  return date;
}

function stringValue(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${name} must be a non-empty string`);
  return value.trim();
}

function stringOptional(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeText(value) {
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function excerpt(value) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
