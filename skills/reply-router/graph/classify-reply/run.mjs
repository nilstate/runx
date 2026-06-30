import crypto from "node:crypto";
import fs from "node:fs";

const inputs = readInputs();
const inbound = objectValue(inputs.inbound_reply, "inbound_reply");
const receipt = objectValue(inputs.original_send_receipt, "original_send_receipt");
const policy = objectValue(inputs.suppression_policy, "suppression_policy");

const replyId = requiredString(inbound.reply_id, "inbound_reply.reply_id");
const body = requiredString(inbound.body, "inbound_reply.body");
const sender = recipientAddress(inbound.from);
const audience = recipientAddress(receipt.send_plan?.audience?.ref ?? receipt.send_plan?.audience);
const receiptId = stringValue(receipt.receipt_id);
const receiptTrust = inspectReceipt(receipt, sender, audience);
const normalized = normalize(body);
const phrases = unsubscribePhrases(policy);
const matchedPhrase = phrases.find((phrase) => containsPhrase(normalized, phrase)) ?? null;
const bareStop = /^(please\s+)?stop[.!\s]*$/u.test(normalized);
const explicitUnsubscribe = Boolean(matchedPhrase) && (!bareStop || phrases.includes("stop"));
const unconfiguredStop = /\bstop\b/u.test(normalized) && !phrases.includes("stop");
const ambiguousIntent = looksAmbiguous(normalized) || unconfiguredStop;
const recipientDigest = sha256(sender || "missing-recipient");

let classification;
let route;
let reason;

if (ambiguousIntent) {
  classification = "ambiguous";
  route = "stop";
  reason = bareStop
    ? "A bare stop request is ambiguous under the supplied suppression policy."
    : "The reply contains a stop signal or conflicting intent that the supplied policy does not resolve.";
} else if (explicitUnsubscribe && receiptTrust.trusted) {
  classification = "unsubscribe";
  route = "suppress";
  reason = `Explicit unsubscribe phrase matched: ${matchedPhrase}`;
} else if (explicitUnsubscribe) {
  classification = "untrusted_unsubscribe";
  route = "stop";
  reason = `Unsubscribe intent was detected, but suppression is unsafe: ${receiptTrust.reasons.join("; ")}`;
} else if (!receiptTrust.trusted) {
  classification = "untrusted_reply";
  route = "stop";
  reason = `The original-send receipt is not trusted: ${receiptTrust.reasons.join("; ")}`;
} else {
  classification = "reply";
  route = "route";
  reason = "The reply is tied to a sealed send and contains no explicit suppression request.";
}

const dataSourceRef = stringValue(policy.data_source_ref) ?? "tenant://reply-router/suppressions";
const storeId = stringValue(policy.store_id) ?? "";
const resource = safeName(stringValue(policy.resource) ?? "reply_suppressions", "suppression_policy.resource");
const aggregateId = `recipient-${recipientDigest.slice(0, 32)}`;
const idempotencyKey = `reply-router:${sha256(`${receiptId ?? "no-receipt"}:${replyId}:${recipientDigest}`).slice(0, 40)}`;
const evidence = {
  reply_id: replyId,
  reply_digest: `sha256:${sha256(normalized)}`,
  sender_digest: `sha256:${recipientDigest}`,
  receipt_id: receiptId,
  matched_phrase: matchedPhrase,
  bare_stop: bareStop,
  recipient_match: receiptTrust.recipient_match,
  raw_reply_retained: false,
};

const result = {
  classification,
  route,
  reason,
  receipt_trust: receiptTrust,
  evidence,
  data_source_ref: dataSourceRef,
  store_id: storeId,
  resource,
  aggregate_id: aggregateId,
  idempotency_key: idempotencyKey,
  suppression_event: route === "suppress"
    ? {
        type: "recipient.unsubscribed",
        payload: {
          schema: "runx.reply.suppression_event.v1",
          recipient_digest: `sha256:${recipientDigest}`,
          source_receipt_id: receiptId,
          source_reply_id: replyId,
          reply_digest: evidence.reply_digest,
          policy_reason: reason,
          observed_at: stringValue(inbound.received_at) ?? null,
        },
      }
    : {},
  routing_decision: route === "route"
    ? {
        schema: "runx.reply.routing.v1",
        action: "handoff",
        queue: stringValue(policy.reply_queue) ?? "governed-reply-review",
        downstream_action_family: "send-as",
        requires_new_authority: true,
        send_side_effects: "none",
        source_receipt_id: receiptId,
        source_reply_id: replyId,
        recipient_digest: `sha256:${recipientDigest}`,
      }
    : {},
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function inspectReceipt(value, senderValue, audienceValue) {
  const reasons = [];
  if (value.schema !== "runx.receipt.v1") reasons.push("schema is not runx.receipt.v1");
  if (value.status !== "sealed" && value.sealed !== true) reasons.push("receipt is not sealed");
  if (!stringValue(value.checksum)) reasons.push("checksum is missing");
  if (!stringValue(value.receipt_id)) reasons.push("receipt_id is missing");
  if (!value.principal || typeof value.principal !== "object") reasons.push("principal is missing");
  if (!value.send_plan || typeof value.send_plan !== "object") reasons.push("send_plan is missing");
  if (!senderValue) reasons.push("inbound sender is missing");
  if (!audienceValue) reasons.push("original audience is missing");
  const recipientMatch = Boolean(senderValue && audienceValue && senderValue === audienceValue);
  if (senderValue && audienceValue && !recipientMatch) reasons.push("inbound sender does not match the original audience");
  return {
    trusted: reasons.length === 0,
    recipient_match: recipientMatch,
    reasons,
  };
}

function unsubscribePhrases(value) {
  const configured = Array.isArray(value.unsubscribe_phrases)
    ? value.unsubscribe_phrases.map((item) => normalize(String(item))).filter(Boolean)
    : [];
  return [...new Set(configured.length > 0 ? configured : ["unsubscribe", "unsubscribe me", "remove me", "opt out"])]
    .sort((a, b) => b.length - a.length);
}

function looksAmbiguous(value) {
  const suppressionSignal = /\b(unsubscribe|remove me|opt out|stop)\b/u.test(value);
  const continuationSignal = /\b(keep|continue|still send|do not unsubscribe|don't unsubscribe)\b/u.test(value);
  return suppressionSignal && continuationSignal;
}

function containsPhrase(value, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, "u").test(value);
}

function recipientAddress(value) {
  const candidate = typeof value === "string" ? value : value?.address ?? value?.ref;
  const parsed = stringValue(candidate);
  return parsed ? parsed.toLowerCase() : null;
}

function normalize(value) {
  return String(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requiredString(value, name) {
  const parsed = stringValue(value);
  if (!parsed) throw new Error(`${name} is required`);
  return parsed;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeName(value, name) {
  if (!/^[A-Za-z0-9._-]+$/u.test(value)) throw new Error(`${name} contains unsupported characters`);
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
