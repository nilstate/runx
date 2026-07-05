import fs from "node:fs";

// ---------------------------------------------------------------------------
// support-firewatch
// Inputs:
//   thread      — object: { customer: string, turns: Turn[] }
//                 Turn = { author: "customer"|"agent", text: string, timestamp: ISO8601 }
//   sla_policy  — object: { response_time_minutes: number, resolution_hours?: number }
// Outputs:
//   signals     — { sentiment, sla_breach, churn_risk }
//   escalation  — { needed, priority, context }
// ---------------------------------------------------------------------------

const inputs = readInputs();

const thread = objectValue(inputs.thread, "thread");
const slaPolicy = inputs.sla_policy ? objectValue(inputs.sla_policy, "sla_policy") : {};

// ---------------------------------------------------------------------------
// Validate thread
// ---------------------------------------------------------------------------

const customer = stringValue(thread.customer);
if (!customer) fail("thread.customer is required and must be a non-empty string");

const turnsRaw = thread.turns;
if (!Array.isArray(turnsRaw)) fail("thread.turns must be an array");
if (turnsRaw.length === 0) fail("thread.turns is empty — nothing to analyze");

const turns = [];
let invalidTurnCount = 0;
for (const raw of turnsRaw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { invalidTurnCount++; continue; }
  const author = stringValue(raw.author);
  const text = stringValue(raw.text);
  const timestamp = stringValue(raw.timestamp);
  if (!author || !text || !timestamp) { invalidTurnCount++; continue; }
  const tsMs = parseIso(timestamp);
  if (tsMs === null) { invalidTurnCount++; continue; }
  turns.push({ author: author.toLowerCase(), text, timestamp, ts_ms: tsMs });
}
if (turns.length === 0) fail("thread.turns has no valid turns (each needs author, text, timestamp)");

// Must have at least one customer turn to assess sentiment/churn
const customerTurns = turns.filter((t) => t.author === "customer");
if (customerTurns.length === 0) fail("thread has no customer turns — cannot assess sentiment or churn risk");

// ---------------------------------------------------------------------------
// Validate SLA policy
// ---------------------------------------------------------------------------

const responseTimeMinutes = numPolicy(slaPolicy.response_time_minutes, null);
if (responseTimeMinutes === null) {
  fail("sla_policy.response_time_minutes is required and must be a number");
}
const resolutionHours = numPolicy(slaPolicy.resolution_hours, null);

// ---------------------------------------------------------------------------
// Signal 1: Sentiment (keyword analysis grounded in customer turns)
// ---------------------------------------------------------------------------

const NEGATIVE_WORDS = [
  "angry", "frustrated", "frustrating", "disappointed", "disappointing",
  "terrible", "awful", "unacceptable", "broken", "useless", "worst",
  "hate", "horrible", "dreadful", "pathetic", "joke", "ridiculous",
  "cancel", "refund", "switch", "leave", "complaint", "complain",
  "fail", "failing", "fails", "failed", "down", "outage",
];
const POSITIVE_WORDS = [
  "great", "happy", "thanks", "thank you", "excellent", "resolved",
  "working", "love", "amazing", "awesome", "good", "appreciate",
  "perfect", "fantastic", "helpful", "solved", "fixed",
];
const CHURN_PHRASES = [
  "cancel", "cancel my", "cancel my account", "close my account",
  "switch to", "switching to", "move to", "moving to",
  "leave", "leaving", "done with", "done with you",
  "competitor", "going to a competitor", "refund and cancel",
];

let negativeHits = 0;
let positiveHits = 0;
let churnHits = 0;
const sentimentEvidence = [];
const churnEvidence = [];

for (const turn of customerTurns) {
  const lower = turn.text.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);

  let turnNeg = 0;
  for (const w of NEGATIVE_WORDS) {
    if (tokens.includes(w) || lower.includes(w)) { turnNeg++; negativeHits++; }
  }
  for (const w of POSITIVE_WORDS) {
    if (tokens.includes(w) || lower.includes(w)) { positiveHits++; }
  }
  if (turnNeg > 0) {
    sentimentEvidence.push({ turn_timestamp: turn.timestamp, text: turn.text, signal: "negative" });
  }

  for (const phrase of CHURN_PHRASES) {
    if (lower.includes(phrase)) {
      churnHits++;
      churnEvidence.push({ turn_timestamp: turn.timestamp, text: turn.text, phrase });
      break; // one churn signal per turn
    }
  }
}

let sentiment;
if (negativeHits >= 3) sentiment = "very_negative";
else if (negativeHits >= 1 && positiveHits === 0) sentiment = "negative";
else if (positiveHits > 0 && negativeHits === 0) sentiment = "positive";
else if (positiveHits > negativeHits) sentiment = "positive";
else if (negativeHits > positiveHits) sentiment = "negative";
else sentiment = "neutral";

// ---------------------------------------------------------------------------
// Signal 2: SLA breach (compare first-response gap to policy clock)
// ---------------------------------------------------------------------------

let slaBreach = false;
const slaEvidence = [];

const firstCustomerTurn = customerTurns[0];
const firstAgentTurn = turns.find((t) => t.author === "agent");

if (firstAgentTurn && firstAgentTurn.ts_ms >= firstCustomerTurn.ts_ms) {
  const responseGapMinutes = (firstAgentTurn.ts_ms - firstCustomerTurn.ts_ms) / 60_000;
  if (responseGapMinutes > responseTimeMinutes) {
    slaBreach = true;
    slaEvidence.push({
      type: "first_response",
      policy_minutes: responseTimeMinutes,
      actual_minutes: Math.round(responseGapMinutes),
      customer_turn_timestamp: firstCustomerTurn.timestamp,
      agent_turn_timestamp: firstAgentTurn.timestamp,
    });
  }
} else if (!firstAgentTurn) {
  // No agent response yet — if thread age exceeds response policy, it's a breach.
  const nowMs = Date.now();
  const waitMinutes = (nowMs - firstCustomerTurn.ts_ms) / 60_000;
  if (waitMinutes > responseTimeMinutes) {
    slaBreach = true;
    slaEvidence.push({
      type: "no_response_within_policy",
      policy_minutes: responseTimeMinutes,
      actual_minutes: Math.round(waitMinutes),
      customer_turn_timestamp: firstCustomerTurn.timestamp,
      agent_turn_timestamp: null,
    });
  }
}

// Resolution SLA (optional): thread duration vs resolution_hours
if (resolutionHours !== null) {
  const lastTurn = turns[turns.length - 1];
  const durationHours = (lastTurn.ts_ms - firstCustomerTurn.ts_ms) / 3_600_000;
  if (durationHours > resolutionHours) {
    slaBreach = true;
    slaEvidence.push({
      type: "resolution",
      policy_hours: resolutionHours,
      actual_hours: Math.round(durationHours * 100) / 100,
      first_turn_timestamp: firstCustomerTurn.timestamp,
      last_turn_timestamp: lastTurn.timestamp,
    });
  }
}

// ---------------------------------------------------------------------------
// Signal 3: Churn risk (grounded in customer turns)
// ---------------------------------------------------------------------------

let churnRisk;
if (churnHits >= 2) churnRisk = "high";
else if (churnHits === 1) churnRisk = "medium";
else if (sentiment === "negative" || sentiment === "very_negative") churnRisk = "low";
else churnRisk = "none";

// ---------------------------------------------------------------------------
// Escalation decision
// ---------------------------------------------------------------------------

const strongSentiment = sentiment === "very_negative";
const moderateSentiment = sentiment === "negative";
const highChurn = churnRisk === "high";
const mediumChurn = churnRisk === "medium";

const signalCount =
  (strongSentiment || moderateSentiment ? 1 : 0) +
  (slaBreach ? 1 : 0) +
  (highChurn || mediumChurn ? 1 : 0);

let needed = false;
let priority = null;
let contextParts = [];

if (strongSentiment || slaBreach || highChurn || mediumChurn) {
  needed = true;

  if (strongSentiment) {
    contextParts.push(`customer sentiment is ${sentiment}`);
  } else if (moderateSentiment) {
    contextParts.push(`customer sentiment is ${sentiment}`);
  }

  if (slaBreach) {
    const ev = slaEvidence[0];
    if (ev.type === "first_response") {
      contextParts.push(`SLA breached (first response ${ev.actual_minutes}m vs ${ev.policy_minutes}m policy)`);
    } else if (ev.type === "no_response_within_policy") {
      contextParts.push(`SLA breached (no agent response within ${ev.policy_minutes}m policy)`);
    } else if (ev.type === "resolution") {
      contextParts.push(`SLA breached (resolution ${ev.actual_hours}h vs ${ev.policy_hours}h policy)`);
    }
  }

  if (highChurn) {
    contextParts.push("high churn risk (cancellation language detected)");
  } else if (mediumChurn) {
    contextParts.push("medium churn risk (churn language detected)");
  }

  // Priority: high when 2+ signals fire, medium for a single strong signal, low borderline
  if (signalCount >= 2) {
    priority = "high";
  } else if (strongSentiment || slaBreach || highChurn) {
    priority = "medium";
  } else {
    priority = "low";
  }
}

if (!needed) {
  contextParts.push("Thread is healthy, no SLA breach, no churn signals.");
}

const escalation = {
  needed,
  priority,
  context: contextParts.join("; ") + ".",
};

// ---------------------------------------------------------------------------
// Build result with grounding evidence
// ---------------------------------------------------------------------------

const result = {
  signals: {
    sentiment,
    sla_breach: slaBreach,
    churn_risk: churnRisk,
    _evidence: {
      sentiment: sentimentEvidence,
      sla_breach: slaEvidence,
      churn_risk: churnEvidence,
    },
  },
  escalation,
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {
    thread: parseInputValue(process.env.RUNX_INPUT_THREAD),
    sla_policy: parseInputValue(process.env.RUNX_INPUT_SLA_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function parseIso(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})/.test(s) && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numPolicy(value, def) {
  return typeof value === "number" && Number.isFinite(value) ? value : def;
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(name + " must be an object");
  return value;
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(64);
}
