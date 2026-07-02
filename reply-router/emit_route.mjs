export function emitRoutingDecision(
  inbound_reply,
  original_send_receipt,
  classification,
) {
  const send_target = {
    run: "send-as",
    dispatch_ref: "send-as:reply-router:follow-up",
    audience: {
      type: "recipient",
      ref: inbound_reply?.received_from || "unknown",
    },
    human_approval_required: true,
  };

  return {
    schema: "runx.reply.routing.v1",
    classification: {
      type: classification.type,
      confidence: classification.confidence,
      evidence: classification.evidence,
    },
    send_target,
    principal: original_send_receipt?.principal || {
      type: "account",
      ref: "unknown",
    },
    sends_now: false,
    governed_run: "send-as",
  };
}
