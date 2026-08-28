import assert from "node:assert/strict";
import test from "node:test";

import {
  finishMarketplaceReady,
  finishMarketplaceWaiting,
  interpretMarketplaceReadback,
  planMarketplaceReadback,
  scheduleMarketplaceReadback,
} from "./readback.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const LISTING = "runx:listing:ausca/document-analysis@analysis-r1#invoke";
const RESOURCE_URL = "https://ausca.example/v1/invocations";
const INVOCATION_ID = "ausca-analysis-1";
const PAYMENT_REF = `runx:x402-payment:${"b".repeat(64)}`;
const RECEIPT_REF = `runx:receipt:sha256:${"c".repeat(64)}`;

test("schedules only bounded durable identity after settlement", () => {
  const result = scheduleMarketplaceReadback({
    settlement: { payment_ref: PAYMENT_REF, invocation_id: INVOCATION_ID },
    marketplace_offer: { listing_ref: LISTING, endpoint_url: RESOURCE_URL },
    resource_url: RESOURCE_URL,
  });

  assert.deepEqual(result.schedule_intent, {
    schema: "runx.external_job_schedule_intent.v1",
    stage_runner: "vendor-readback",
    checkpoint: {
      schema: "runx.marketplace_vendor_readback_checkpoint.v1",
      settlement_family: "x402",
      payment_ref: PAYMENT_REF,
      invocation_id: INVOCATION_ID,
      resource_url: RESOURCE_URL,
      listing_ref: LISTING,
    },
    max_attempts: 128,
    initial_delay_ms: 0,
    deadline_ms: 21_600_000,
  });
});

test("maps one pending observation to durable waiting state", () => {
  const plan = planMarketplaceReadback({ request: stageRequest("inspect") });
  const action = interpretMarketplaceReadback({
    checkpoint: plan.checkpoint,
    provider_job_ref: plan.provider_job_ref,
    readback: readback("pending", { resource_state: "running" }),
  }).action;

  assert.equal(action.kind, "waiting");
  assert.deepEqual(finishMarketplaceWaiting({ action }).stage_result, {
    status: "waiting",
    provider_job_ref: plan.provider_job_ref,
    checkpoint: plan.checkpoint,
    retry_after_ms: 5_000,
  });
});

test("binds terminal vendor result, composite marker, artifact, and evidence", () => {
  const plan = planMarketplaceReadback({ request: stageRequest("start") });
  const action = interpretMarketplaceReadback({
    checkpoint: plan.checkpoint,
    provider_job_ref: plan.provider_job_ref,
    readback: readback("complete", {
      finality: "confirmed",
      inner_receipt_ref: RECEIPT_REF,
      resource_result: { invocation: { state: "succeeded" } },
      runx_composite: {
        inner_receipt_ref: RECEIPT_REF,
        inner_invocation_id: INVOCATION_ID,
        listing_ref: LISTING,
        vendor_ref_uri: "runx:principal:ausca",
      },
    }),
  }).action;

  assert.deepEqual(action.result, {
    schema: "runx.marketplace_vendor_result.v1",
    result: { invocation: { state: "succeeded" } },
    runx_composite: {
      inner_receipt_ref: RECEIPT_REF,
      inner_invocation_id: INVOCATION_ID,
      listing_ref: LISTING,
      vendor_ref_uri: "runx:principal:ausca",
    },
  });
  assert.deepEqual(finishMarketplaceReady({
    action,
    artifact_result: { artifact_ref: `runx:artifact:${DIGEST}` },
    digest_result: { digest: DIGEST },
  }).stage_result, {
    status: "ready",
    provider_job_ref: plan.provider_job_ref,
    result_artifact_ref: { type: "artifact", uri: `runx:artifact:${DIGEST}` },
    evidence_ref: { type: "verification", uri: `${plan.provider_job_ref.uri}#readback` },
    evidence_digest: DIGEST,
  });
});

function stageRequest(stage) {
  return {
    operation_key: DIGEST,
    continuation: { stage },
    checkpoint: {
      schema: "runx.marketplace_vendor_readback_checkpoint.v1",
      settlement_family: "x402",
      payment_ref: PAYMENT_REF,
      invocation_id: INVOCATION_ID,
      resource_url: RESOURCE_URL,
      listing_ref: LISTING,
    },
  };
}

function readback(status, extra = {}) {
  return {
    payment_ref: PAYMENT_REF,
    invocation_id: INVOCATION_ID,
    readback_status: status,
    transaction: `0x${"d".repeat(64)}`,
    payment_required_digest: DIGEST,
    payment_response_digest: DIGEST,
    ...extra,
  };
}
