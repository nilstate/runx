import { createHash } from "node:crypto";

export async function appendSuppressionEvent(
  inbound_reply,
  original_send_receipt,
  store_projection,
  classification,
) {
  const aggregate_id =
    store_projection?.aggregate_id || inbound_reply?.received_from || "unknown";
  const before_version = store_projection?.version ?? 0;
  const after_version = before_version + 1;

  const idempotencyKey =
    store_projection?.idempotency_key ||
    createHash("sha256")
      .update(`reply-router:${aggregate_id}:${before_version}`)
      .digest("hex");

  return {
    schema: "runx.reply.suppression_event.v1",
    store_id: store_projection?.store_id || "runx.reply-router.suppression.v1",
    registry: "registry:runx/data-store@0.1.2",
    operation: "append_event",
    aggregate_id,
    expected_version: before_version,
    idempotency_key: idempotencyKey,
    before_version,
    after_version,
    event: {
      type: "reply_router.suppression_recorded",
      payload: {
        classification_type: classification.type,
        confidence: classification.confidence,
        matched_signals: classification.evidence,
        received_from: inbound_reply.received_from,
        received_at: inbound_reply.received_at,
        original_receipt_id: original_send_receipt?.receipt_id,
      },
    },
  };
}
