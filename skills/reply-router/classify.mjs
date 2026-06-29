function readInputs() {
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {};
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

function hasSealedReceipt(receipt) {
  return Boolean(
    receipt &&
      receipt.sealed === true &&
      typeof receipt.receipt_id === "string" &&
      receipt.receipt_id.length > 0 &&
      typeof receipt.checksum === "string" &&
      receipt.checksum.startsWith("sha256:")
  );
}

function matchingSignals(content, policy) {
  const lower = normalize(content);
  return (policy?.unsubscribe_signals || [])
    .map((signal) => String(signal || "").trim())
    .filter((signal) => signal.length > 0)
    .filter((signal) => lower.includes(signal.toLowerCase()));
}

const inputs = readInputs();
const inbound = inputs.inbound_reply || {};
const receipt = inputs.original_send_receipt || {};
const policy = inputs.suppression_policy || {};
const threshold = Number(policy.confidence_threshold ?? 0.9);
const content = String(inbound.content || "");
const signals = matchingSignals(content, policy);
const sealed = hasSealedReceipt(receipt);
let decision;

if (!sealed) {
  decision = {
    route: "needs_agent",
    reason: "original_send_receipt is missing sealed receipt evidence",
    classification: {
      type: "needs_agent",
      confidence: 1,
      evidence: ["original_send_receipt must be sealed and carry a sha256 checksum"]
    }
  };
} else if (signals.length > 0 && threshold <= 0.95) {
  decision = {
    route: "suppress",
    reason: "unsubscribe intent matched policy signal",
    classification: {
      type: "unsubscribe",
      confidence: 0.99,
      evidence: signals.map((signal) => `matched signal: ${signal}`)
    }
  };
} else if (/^(thanks|thank you|sounds good|yes|ok|okay|interested)\b/i.test(content.trim())) {
  decision = {
    route: "route",
    reason: "normal reply with sealed original send receipt",
    classification: {
      type: "reply",
      confidence: 0.92,
      evidence: ["reply content is not an unsubscribe request"]
    }
  };
} else {
  decision = {
    route: "needs_agent",
    reason: "reply text is ambiguous and no unsubscribe signal is grounded",
    classification: {
      type: "ambiguous",
      confidence: 0.54,
      evidence: ["content lacks a clear unsubscribe signal and lacks an affirmative routing signal"]
    }
  };
}

process.stdout.write(JSON.stringify({
  ...decision,
  decision,
  classification_packet: {
    data: decision
  }
}));
