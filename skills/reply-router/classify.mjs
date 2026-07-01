// reply-router · classify step
// Reads inbound_reply, original_send_receipt, suppression_policy and emits a
// classification plus a routing branch. The graph runner consumes the
// classification_packet.data.route field to branch to suppress / route / human.
function readInputs() {
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {};
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

// A sealed receipt must be explicitly sealed, carry a non-empty receipt_id,
// and a sha256: checksum. We refuse to classify on anything weaker.
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

// Only signals present in the policy AND grounded in the reply text count.
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
  // Unsealed or checksum-less receipt: refuse to classify, escalate to agent.
  decision = {
    route: "needs_agent",
    reason: "original_send_receipt is not sealed or is missing a sha256 checksum",
    classification: {
      type: "needs_agent",
      confidence: 1,
      evidence: ["original_send_receipt must be sealed and carry a sha256 checksum"]
    }
  };
} else if (signals.length > 0) {
  // Unsubscribe intent grounded in the reply text and named in the policy.
  decision = {
    route: "suppress",
    reason: "unsubscribe intent matched policy signal(s)",
    classification: {
      type: "unsubscribe",
      confidence: 0.99,
      evidence: signals.map((signal) => `matched signal: ${signal}`)
    }
  };
} else if (/^(thanks|thank you|sounds good|yes|ok|okay|interested|sure|let'?s do it)\b/i.test(content.trim())) {
  // Affirmative, non-unsubscribe reply: route to a later governed send-as run.
  decision = {
    route: "route",
    reason: "affirmative reply with sealed original send receipt",
    classification: {
      type: "reply",
      confidence: 0.92,
      evidence: ["reply content is an affirmative non-unsubscribe response"]
    }
  };
} else {
  // Ambiguous: no unsubscribe signal and no affirmative routing signal.
  decision = {
    route: "needs_agent",
    reason: "reply text is ambiguous; no unsubscribe signal and no affirmative routing signal grounded in content",
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
