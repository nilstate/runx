import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Read inputs
// ---------------------------------------------------------------------------

const inputs = readInputs();

const inboundReply = objectValue(inputs.inbound_reply, "inbound_reply");
const sendReceipt = objectValue(inputs.original_send_receipt, "original_send_receipt");
const policy = inputs.suppression_policy ? objectValue(inputs.suppression_policy, "suppression_policy") : {};

// ---------------------------------------------------------------------------
// Validate required fields
// ---------------------------------------------------------------------------

const content = stringValue(inboundReply.content);
if (!content) fail("inbound_reply.content is required and must be a non-empty string");

const receivedFrom = stringValue(inboundReply.received_from);
if (!receivedFrom) fail("inbound_reply.received_from is required");

const receivedAt = stringValue(inboundReply.received_at);
if (!receivedAt) fail("inbound_reply.received_at is required");

const sendPlan = stringValue(sendReceipt.send_plan);
const principal = stringValue(sendReceipt.principal);
const receiptId = stringValue(sendReceipt.receipt_id);
const checksum = stringValue(sendReceipt.checksum);

if (!principal) fail("original_send_receipt.principal is required");

// Unsealed receipt check: must have both receipt_id and checksum
if (!receiptId || !checksum) {
  fail("original_send_receipt is unsealed: both receipt_id and checksum are required to route a reply");
}

// ---------------------------------------------------------------------------
// Suppression policy defaults
// ---------------------------------------------------------------------------

const unsubscribeSignals = Array.isArray(policy.unsubscribe_signals)
  ? policy.unsubscribe_signals.map((s) => String(s).toLowerCase())
  : ["unsubscribe", "stop sending", "remove me", "opt out", "don't want", "take me off", "no longer", "mailing list"];

const confidenceThreshold = typeof policy.confidence_threshold === "number" ? policy.confidence_threshold : 0.75;

// ---------------------------------------------------------------------------
// Classify
// ---------------------------------------------------------------------------

const normalized = normalize(content);
const classification = classify(normalized, unsubscribeSignals);

if (classification.confidence < confidenceThreshold) {
  fail(`ambiguous reply: best classification '${classification.type}' has confidence ${classification.confidence} below threshold ${confidenceThreshold}`);
}

// ---------------------------------------------------------------------------
// Route or suppress
// ---------------------------------------------------------------------------

let result;

if (classification.type === "unsubscribe") {
  const suppressionResult = suppress({ principal, receiptId, checksum, sendPlan, content, receivedFrom, receivedAt });
  result = { classification, suppression_result: suppressionResult };
} else {
  const sendTarget = sendTargetFor(classification.type);
  result = {
    classification,
    "runx.reply.routing.v1": { classification: classification.type, send_target: sendTarget, principal },
  };
}

process.stdout.write(JSON.stringify(result, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Classification logic
// ---------------------------------------------------------------------------

function classify(text, unsubSignals) {
  const checks = [
    { type: "unsubscribe", signals: unsubSignals, baseConfidence: 0.9 },
    { type: "out_of_office", signals: ["out of office", "ooo", "on vacation", "away from", "auto-reply", "automatic reply", "auto reply", "will be away", "currently away"], baseConfidence: 0.88 },
    { type: "wrong_person", signals: ["wrong person", "not me", "wrong number", "wrong address", "who is this", "not the right", "mistake", "reached the wrong"], baseConfidence: 0.82 },
    { type: "objection", signals: ["not interested", "too expensive", "not now", "maybe later", "can't afford", "no budget", "not a fit", "pass on this", "decline", "no thank"], baseConfidence: 0.8 },
    { type: "interested", signals: ["interested", "tell me more", "sounds good", "let's do it", "lets do it", "sign me up", "how do we start", "let's talk", "lets talk", "let's set up"], baseConfidence: 0.8 },
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

function sendTargetFor(type) {
  switch (type) {
    case "interested": return "sales-follow-up";
    case "objection": return "objection-handling";
    case "out_of_office": return "schedule-retry";
    case "wrong_person": return "contact-cleanup";
    default: return "manual-review";
  }
}

// ---------------------------------------------------------------------------
// Suppression (local event store with CAS)
// ---------------------------------------------------------------------------

function suppress({ principal, receiptId, checksum, sendPlan, content, receivedFrom, receivedAt }) {
  const aggregateId = `${principal}:${receiptId}`;
  const idempotencyKey = `${aggregateId}:unsubscribe:${checksum}`;

  const storeDir = path.join(os.tmpdir(), "runx-reply-router-store");
  fs.mkdirSync(storeDir, { recursive: true });
  const storeFile = path.join(storeDir, crypto.createHash("sha256").update(aggregateId).digest("hex") + ".json");

  let store;
  if (fs.existsSync(storeFile)) {
    store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  } else {
    store = { aggregate_id: aggregateId, version: 0, events: [], idempotency_keys: {} };
  }

  // Idempotency: if already processed, return cached result
  if (store.idempotency_keys[idempotencyKey]) {
    const cached = store.idempotency_keys[idempotencyKey];
    return { aggregate_id: aggregateId, idempotency_key: idempotencyKey, before_version: cached.before_version, after_version: cached.after_version };
  }

  // CAS append
  const beforeVersion = store.version;
  const afterVersion = store.version + 1;

  const event = {
    type: "suppression.unsubscribe",
    aggregate_id: aggregateId,
    version: afterVersion,
    idempotency_key: idempotencyKey,
    payload: {
      principal, receipt_id: receiptId, checksum, send_plan: sendPlan,
      reply_content_summary: summarize(content), received_from: receivedFrom,
      received_at: receivedAt, suppressed_at: new Date().toISOString(),
    },
  };

  store.events.push(event);
  store.version = afterVersion;
  store.idempotency_keys[idempotencyKey] = { before_version: beforeVersion, after_version: afterVersion };
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2));

  return { aggregate_id: aggregateId, idempotency_key: idempotencyKey, before_version: beforeVersion, after_version: afterVersion };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {
    inbound_reply: parseInputValue(process.env.RUNX_INPUT_INBOUND_REPLY),
    original_send_receipt: parseInputValue(process.env.RUNX_INPUT_ORIGINAL_SEND_RECEIPT),
    suppression_policy: parseInputValue(process.env.RUNX_INPUT_SUPPRESSION_POLICY),
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
