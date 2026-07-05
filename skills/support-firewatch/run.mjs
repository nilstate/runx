import fs from "node:fs";

const negativeSignals = [
  "angry",
  "frustrated",
  "unacceptable",
  "no response",
  "ignored",
  "blocked",
  "broken",
  "down",
  "failed",
  "failure",
  "escalate",
];

const positiveSignals = [
  "thanks",
  "thank you",
  "resolved",
  "works now",
  "appreciate",
  "helpful",
];

const churnSignals = [
  "cancel",
  "cancellation",
  "refund",
  "chargeback",
  "switch vendor",
  "competitor",
  "contract",
  "renewal",
  "downgrade",
  "enterprise",
  "churn",
];

const inputs = readInputs();
const thread = objectValue(inputs.thread, "thread");
const policy = objectValue(inputs.sla_policy, "sla_policy");
const messages = normalizeMessages(thread.messages);

if (messages.length === 0 && !stringValue(thread.subject) && !stringValue(thread.body)) {
  fail("thread.messages, thread.subject, or thread.body is required");
}

const currentTime = parseDate(thread.current_time ?? policy.current_time) ?? new Date();
const text = normalize([
  thread.subject,
  thread.body,
  ...messages.map((message) => message.body),
].filter(Boolean).join("\n"));
const lastCustomerMessage = lastMessageByRole(messages, "customer");
const lastAgentMessage = lastMessageByRole(messages, "agent");
const thresholdHours = thresholdFor(thread, policy);
const ageHours = lastCustomerMessage
  ? hoursBetween(lastCustomerMessage.created_at, currentTime)
  : null;
const agentRespondedAfterCustomer = Boolean(
  lastCustomerMessage
    && lastAgentMessage
    && lastAgentMessage.created_at > lastCustomerMessage.created_at,
);
const slaBreached = Boolean(
  lastCustomerMessage
    && !agentRespondedAfterCustomer
    && ageHours !== null
    && ageHours > thresholdHours,
);

const sentiment = sentimentFor(text);
const churnRisk = churnRiskFor({ text, thread, sentiment, slaBreached });
const escalation = escalationFor({ slaBreached, churnRisk, sentiment, ageHours, thresholdHours, thread });
const matchedSignals = [
  ...signalsFor(text, negativeSignals),
  ...signalsFor(text, churnSignals),
  ...(slaBreached ? ["sla_breach"] : []),
  ...(isVip(thread) ? ["vip_customer"] : []),
];

const result = {
  signals: {
    sentiment,
    sla_breach: {
      breached: slaBreached,
      age_hours: ageHours === null ? null : round(ageHours),
      threshold_hours: thresholdHours,
      last_customer_message_at: lastCustomerMessage?.created_at.toISOString() ?? null,
      agent_responded_after_customer: agentRespondedAfterCustomer,
    },
    churn_risk: churnRisk,
  },
  escalation,
  evidence: {
    source: stringValue(thread.source) ?? "inline_support_thread",
    source_summary: summarize(thread.subject, messages),
    matched_signals: [...new Set(matchedSignals)],
    message_count: messages.length,
    customer_tier: stringValue(thread.customer_tier) ?? null,
    policy_name: stringValue(policy.policy_name) ?? "support-firewatch-policy",
    limitations: limitationsFor({ messages, lastCustomerMessage, thresholdHours }),
    side_effects: "none",
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
    thread: parseInput(process.env.RUNX_INPUT_THREAD),
    sla_policy: parseInput(process.env.RUNX_INPUT_SLA_POLICY),
  };
}

function parseInput(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeMessages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("thread.messages must be an array when provided");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`thread.messages[${index}] must be an object`);
    }
    const body = stringValue(entry.body);
    if (!body) fail(`thread.messages[${index}].body is required`);
    return {
      author: stringValue(entry.author) ?? "unknown",
      role: normalizeRole(entry.role),
      body,
      created_at: parseDate(entry.created_at) ?? new Date(0),
    };
  });
}

function normalizeRole(value) {
  const role = stringValue(value)?.toLowerCase();
  if (role === "customer" || role === "agent" || role === "system") return role;
  return "customer";
}

function parseDate(value) {
  const raw = stringValue(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function thresholdFor(threadValue, policyValue) {
  const base = positiveNumber(policyValue.response_hours) ?? 24;
  const vip = positiveNumber(policyValue.vip_response_hours);
  return isVip(threadValue) && vip ? vip : base;
}

function isVip(threadValue) {
  return matches(normalize(threadValue.customer_tier), ["enterprise", "vip", "strategic", "paid"]);
}

function sentimentFor(text) {
  const negative = signalsFor(text, negativeSignals).length;
  const positive = signalsFor(text, positiveSignals).length;
  if (negative >= 3) return "strong_negative";
  if (negative > positive) return "negative";
  if (positive > negative) return "positive";
  return "neutral";
}

function churnRiskFor({ text, thread: threadValue, sentiment, slaBreached }) {
  const drivers = [];
  const churnMatches = signalsFor(text, churnSignals);
  drivers.push(...churnMatches);
  if (isVip(threadValue)) drivers.push("vip_customer");
  if (slaBreached) drivers.push("sla_breach");
  if (sentiment === "strong_negative") drivers.push("strong_negative_sentiment");

  let score = 0;
  score += Math.min(churnMatches.length * 0.18, 0.54);
  if (isVip(threadValue)) score += 0.18;
  if (slaBreached) score += 0.22;
  if (sentiment === "strong_negative") score += 0.18;
  if (sentiment === "negative") score += 0.1;
  score = Math.min(score, 0.99);

  return {
    level: score >= 0.7 ? "high" : score >= 0.35 ? "medium" : "low",
    score: round(score),
    drivers: [...new Set(drivers)],
  };
}

function escalationFor({ slaBreached, churnRisk, sentiment, ageHours, thresholdHours, thread: threadValue }) {
  const needed = slaBreached || churnRisk.level === "high" || sentiment === "strong_negative";
  if (!needed) {
    return {
      needed: false,
      priority: "none",
      context: "No SLA breach, high churn risk, or strongly negative sentiment was found.",
    };
  }

  const priority = churnRisk.level === "high" && slaBreached
    ? "urgent"
    : churnRisk.level === "high" || sentiment === "strong_negative"
      ? "high"
      : "normal";
  const parts = [];
  if (slaBreached) {
    parts.push(`thread is ${round(ageHours)}h old against a ${thresholdHours}h SLA`);
  }
  if (churnRisk.drivers.length > 0) {
    parts.push(`risk drivers: ${churnRisk.drivers.join(", ")}`);
  }
  if (isVip(threadValue)) {
    parts.push("customer tier is escalated");
  }
  return {
    needed: true,
    priority,
    context: sentence(parts),
  };
}

function limitationsFor({ messages, lastCustomerMessage, thresholdHours }) {
  const limitations = [];
  if (messages.length === 0) limitations.push("No structured messages were provided.");
  if (!lastCustomerMessage) limitations.push("No customer-authored message timestamp was available.");
  if (!thresholdHours) limitations.push("SLA threshold fell back to the default.");
  return limitations;
}

function lastMessageByRole(messages, role) {
  return messages
    .filter((message) => message.role === role)
    .sort((a, b) => a.created_at - b.created_at)
    .at(-1) ?? null;
}

function hoursBetween(start, end) {
  return Math.max(0, (end.getTime() - start.getTime()) / 3_600_000);
}

function summarize(subject, messages) {
  const candidate = stringValue(subject) ?? messages[0]?.body ?? "support thread";
  const oneLine = String(candidate).replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

function signalsFor(text, dictionary) {
  return dictionary.filter((signal) => text.includes(signal));
}

function matches(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function sentence(parts) {
  if (parts.length === 0) return "Escalation is needed based on the supplied thread.";
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
