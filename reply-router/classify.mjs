export async function classify(inbound_reply, original_send_receipt, suppression_policy) {
  if (!inbound_reply || !inbound_reply.content) {
    return {
      type: "ambiguous",
      confidence: 0,
      evidence: [],
      route: "needs_agent",
      reason: "No reply content to classify.",
    };
  }

  if (!original_send_receipt || !original_send_receipt.sealed) {
    return {
      type: "ambiguous",
      confidence: 0,
      evidence: [],
      route: "needs_agent",
      reason: "Original send receipt is not sealed. Cannot verify provenance.",
    };
  }

  const content = inbound_reply.content.toLowerCase();
  const signals = suppression_policy?.unsubscribe_signals || [];
  const threshold = suppression_policy?.confidence_threshold ?? 0.9;

  const matched = signals.filter((s) => content.includes(s.toLowerCase()));
  const confidence = matched.length > 0
    ? Math.min(0.5 + matched.length * 0.25, 0.99)
    : 0.1;

  if (matched.length > 0 && confidence >= threshold) {
    return {
      type: "unsubscribe",
      confidence: Math.round(confidence * 100) / 100,
      evidence: matched.map((s) => `matched signal: ${s}`),
      route: "suppress",
      reason: `Matched ${matched.length} unsubscribe signal(s) at confidence ${Math.round(confidence * 100) / 100}.`,
    };
  }

  if (matched.length > 0 && confidence < threshold) {
    return {
      type: "ambiguous",
      confidence: Math.round(confidence * 100) / 100,
      evidence: matched.map((s) => `weak signal: ${s}`),
      route: "needs_agent",
      reason: `Matched ${matched.length} signal(s) but confidence ${Math.round(confidence * 100) / 100} below threshold ${threshold}. Needs human review.`,
    };
  }

  return {
    type: "reply",
    confidence: Math.round(confidence * 100) / 100,
    evidence: ["Reply content present and no unsubscribe signals matched."],
    route: "route",
    reason: "Non-unsubscribe reply routed for follow-up.",
  };
}
