import fs from "node:fs";

// ---------------------------------------------------------------------------
// Read inputs
// ---------------------------------------------------------------------------

const inputs = readInputs();

const ticket = objectValue(inputs.ticket, "ticket");
const context = inputs.context ? objectValue(inputs.context, "context") : {};
const policy = inputs.triage_policy ? objectValue(inputs.triage_policy, "triage_policy") : {};

// ---------------------------------------------------------------------------
// Validate required fields
// ---------------------------------------------------------------------------

const content = stringValue(ticket.content);
if (!content) fail("ticket.content is required and must be a non-empty string");

const submittedBy = stringValue(ticket.submitted_by);
if (!submittedBy) fail("ticket.submitted_by is required");

const submittedAt = stringValue(ticket.submitted_at);
if (!submittedAt) fail("ticket.submitted_at is required");

const product = stringValue(context.product);
const tier = stringValue(context.tier);

// ---------------------------------------------------------------------------
// Triage policy defaults
// ---------------------------------------------------------------------------

const urgentSignals = Array.isArray(policy.urgent_signals)
  ? policy.urgent_signals.map((s) => String(s).toLowerCase())
  : ["production down", "outage", "critical", "sev1", "sev-1", "down", "emergency", "all users", "cannot access", "data loss"];

const confidenceThreshold = typeof policy.confidence_threshold === "number" ? policy.confidence_threshold : 0.75;

// ---------------------------------------------------------------------------
// Regulated-action guard: stop rather than auto-route sensitive requests
// ---------------------------------------------------------------------------

const regulatedSignals = [
  "refund", "cancel my subscription", "delete my account", "delete my data",
  "password reset", "reset my password", "data export", "export my data",
  "change my billing", "credit card", "pci", "hipaa", "gdpr", "right to be forgotten",
  "close my account",
];

const normalized = normalize(content);
const regulatedHit = regulatedSignals.find((s) => normalized.includes(s));
if (regulatedHit) {
  fail(`regulated action detected ('${regulatedHit}'): ticket requires a stronger authority gate and cannot be auto-routed`);
}

// ---------------------------------------------------------------------------
// Classify
// ---------------------------------------------------------------------------

const classification = classify(normalized, urgentSignals);

if (classification.confidence < confidenceThreshold) {
  fail(`ambiguous ticket: best classification '${classification.type}' has confidence ${classification.confidence} below threshold ${confidenceThreshold}`);
}

// ---------------------------------------------------------------------------
// Escalate (urgent) or route (bug, feature_request, how_to)
// ---------------------------------------------------------------------------

let result;

if (classification.type === "urgent") {
  const priority = priorityFor(tier);
  result = {
    classification,
    "runx.support.escalation.v1": {
      classification: classification.type,
      escalation_target: "on-call-engineer",
      priority,
      submitted_by: submittedBy,
    },
  };
} else {
  const handlingLane = handlingLaneFor(classification.type, product);
  const responseTemplate = responseTemplateFor(classification.type);
  result = {
    classification,
    "runx.support.routing.v1": {
      classification: classification.type,
      handling_lane: handlingLane,
      suggested_response_template: responseTemplate,
      submitted_by: submittedBy,
    },
  };
}

process.stdout.write(JSON.stringify(result, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Classification logic
// ---------------------------------------------------------------------------

function classify(text, urgentSigs) {
  const checks = [
    { type: "urgent", signals: urgentSigs, baseConfidence: 0.9 },
    { type: "bug", signals: ["bug", "error", "stack trace", "broken", "crash", "exception", "traceback", "does not work", "doesn't work", "fails", "failing", "500", "404", "null pointer", "undefined is not"], baseConfidence: 0.8 },
    { type: "feature_request", signals: ["feature request", "would be great if", "wish i could", "it would be nice", "can you add", "requesting a feature", "enhancement", "suggestion", "idea: ", "proposal"], baseConfidence: 0.8 },
    { type: "how_to", signals: ["how do i", "how to", "how can i", "where do i", "where can i", "what is", "help me understand", "documentation", "docs", "guide", "tutorial", "is it possible to", "can i"], baseConfidence: 0.78 },
  ];

  let best = { type: "unknown", confidence: 0, evidence: { matched_signals: [], source_summary: summarize(content) } };

  for (const check of checks) {
    const matched = check.signals.filter((s) => text.includes(s));
    if (matched.length === 0) continue;
    const confidence = Math.min(0.98, check.baseConfidence + matched.length * 0.03);
    if (confidence > best.confidence) {
      best = { type: check.type, confidence: round(confidence), evidence: { matched_signals: matched, source_summary: summarize(content) } };
    }
  }
  return best;
}

function priorityFor(tier) {
  if (tier === "enterprise") return "P1";
  if (tier === "business") return "P2";
  return "P3";
}

function handlingLaneFor(type, product) {
  const prefix = product ? `${product}-` : "";
  switch (type) {
    case "bug": return `${prefix}engineering-bugs`;
    case "feature_request": return `${prefix}product-backlog`;
    case "how_to": return `${prefix}customer-success`;
    default: return "manual-review";
  }
}

function responseTemplateFor(type) {
  switch (type) {
    case "bug": return "bug-acknowledgment";
    case "feature_request": return "feature-request-acknowledgment";
    case "how_to": return "how-to-guidance";
    default: return "generic-acknowledgment";
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {
    ticket: parseInputValue(process.env.RUNX_INPUT_TICKET),
    context: parseInputValue(process.env.RUNX_INPUT_CONTEXT),
    triage_policy: parseInputValue(process.env.RUNX_INPUT_TRIAGE_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function normalize(value) { return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim(); }
function summarize(text) { const s = String(text ?? "").replace(/\s+/g, " ").trim(); return s.length > 140 ? s.slice(0, 137) + "..." : s; }
function round(n) { return Math.round(n * 100) / 100; }
function stringValue(value) { return typeof value === "string" && value.trim().length > 0 ? value.trim() : null; }
function objectValue(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(name + " must be an object"); return value; }
function fail(message) { process.stderr.write(message + "\n"); process.exit(64); }
