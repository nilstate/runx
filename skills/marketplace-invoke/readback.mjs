const CHECKPOINT_SCHEMA = "runx.marketplace_vendor_readback_checkpoint.v1";
const SCHEDULE_SCHEMA = "runx.external_job_schedule_intent.v1";
const MAX_ATTEMPTS = 128;
const DEADLINE_MS = 6 * 60 * 60 * 1_000;

export function scheduleMarketplaceReadback(inputs) {
  const settlement = record(inputs.settlement, "x402 settlement");
  const offer = record(inputs.marketplace_offer, "marketplace offer");
  const resourceUrl = httpsUrl(inputs.resource_url, "Marketplace resource URL");
  if (offer.endpoint_url !== resourceUrl) {
    throw new Error("Marketplace settlement endpoint changed before continuation.");
  }
  const checkpoint = Object.freeze({
    schema: CHECKPOINT_SCHEMA,
    settlement_family: "x402",
    payment_ref: boundedText(settlement.payment_ref, 300, "Payment reference"),
    invocation_id: boundedText(settlement.invocation_id, 256, "Vendor invocation id"),
    resource_url: resourceUrl,
    listing_ref: listingReference(offer.listing_ref),
  });
  return {
    schedule_intent: Object.freeze({
      schema: SCHEDULE_SCHEMA,
      stage_runner: "vendor-readback",
      checkpoint,
      max_attempts: MAX_ATTEMPTS,
      initial_delay_ms: 0,
      deadline_ms: DEADLINE_MS,
    }),
  };
}

export function planMarketplaceReadback(inputs) {
  const request = record(inputs.request, "External job stage request");
  const continuation = record(request.continuation, "External job continuation");
  if (continuation.stage !== "start" && continuation.stage !== "inspect") {
    throw new Error("Marketplace readback accepts only start or inspect stages.");
  }
  digest(request.operation_key);
  const checkpoint = readbackCheckpoint(request.checkpoint);
  return {
    checkpoint,
    provider_job_ref: providerJobReference(checkpoint.invocation_id),
    readback_input: Object.freeze({
      resource_url: checkpoint.resource_url,
      payment_ref: checkpoint.payment_ref,
    }),
  };
}

export function interpretMarketplaceReadback(inputs) {
  const checkpoint = readbackCheckpoint(inputs.checkpoint);
  const providerJobRef = targetReference(inputs.provider_job_ref);
  const expectedJobRef = providerJobReference(checkpoint.invocation_id);
  if (providerJobRef.uri !== expectedJobRef.uri) {
    throw new Error("Marketplace provider job identity changed during readback.");
  }
  const readback = record(inputs.readback, "x402 readback");
  if (readback.payment_ref !== checkpoint.payment_ref
    || readback.invocation_id !== checkpoint.invocation_id) {
    throw new Error("Marketplace readback changed payment or invocation identity.");
  }
  if (readback.readback_status === "pending") {
    return {
      action: Object.freeze({
        kind: "waiting",
        checkpoint,
        provider_job_ref: providerJobRef,
      }),
    };
  }
  if (readback.readback_status === "failed") {
    const state = boundedText(readback.resource_state, 96, "Vendor failure state");
    return {
      action: Object.freeze({
        kind: "failed",
        provider_job_ref: providerJobRef,
        evidence: completionEvidence(checkpoint, readback, state),
        message: `Vendor invocation completed as ${state}.`,
      }),
    };
  }
  if (readback.readback_status !== "complete"
    || readback.finality !== "confirmed"
    || !receiptReference(readback.inner_receipt_ref)
    || !recordOrArray(readback.resource_result)) {
    throw new Error("Marketplace completed readback lacks canonical result evidence.");
  }
  const composite = record(readback.runx_composite, "Marketplace composite marker");
  if (composite.inner_receipt_ref !== readback.inner_receipt_ref
    || composite.inner_invocation_id !== checkpoint.invocation_id
    || composite.listing_ref !== checkpoint.listing_ref) {
    throw new Error("Marketplace composite marker changed admitted vendor identity.");
  }
  return {
    action: Object.freeze({
      kind: "ready",
      provider_job_ref: providerJobRef,
      result: Object.freeze({
        schema: "runx.marketplace_vendor_result.v1",
        result: readback.resource_result,
        runx_composite: composite,
      }),
      evidence: completionEvidence(checkpoint, readback, "complete"),
    }),
  };
}

export function finishMarketplaceWaiting(inputs) {
  const action = actionOf(inputs.action, "waiting");
  return {
    stage_result: Object.freeze({
      status: "waiting",
      provider_job_ref: action.provider_job_ref,
      checkpoint: action.checkpoint,
      retry_after_ms: 5_000,
    }),
  };
}

export function finishMarketplaceFailure(inputs) {
  const action = actionOf(inputs.action, "failed");
  return {
    stage_result: Object.freeze({
      status: "provider_failed",
      provider_job_ref: action.provider_job_ref,
      evidence_ref: readbackEvidenceReference(action.provider_job_ref),
      evidence_digest: digest(record(inputs.digest_result, "Failure digest result").digest),
      failure: Object.freeze({
        code: "marketplace_vendor_failed",
        message: boundedText(action.message, 500, "Vendor failure message"),
        retryable: false,
      }),
    }),
  };
}

export function finishMarketplaceReady(inputs) {
  const action = actionOf(inputs.action, "ready");
  const artifact = record(inputs.artifact_result, "Marketplace result artifact");
  return {
    stage_result: Object.freeze({
      status: "ready",
      provider_job_ref: action.provider_job_ref,
      result_artifact_ref: artifactReference(artifact.artifact_ref),
      evidence_ref: readbackEvidenceReference(action.provider_job_ref),
      evidence_digest: digest(record(inputs.digest_result, "Completion digest result").digest),
    }),
  };
}

function readbackCheckpoint(value) {
  const checkpoint = record(value, "Marketplace readback checkpoint");
  if (checkpoint.schema !== CHECKPOINT_SCHEMA || checkpoint.settlement_family !== "x402") {
    throw new Error("Marketplace readback checkpoint identity is invalid.");
  }
  return Object.freeze({
    schema: CHECKPOINT_SCHEMA,
    settlement_family: "x402",
    payment_ref: boundedText(checkpoint.payment_ref, 300, "Payment reference"),
    invocation_id: boundedText(checkpoint.invocation_id, 256, "Vendor invocation id"),
    resource_url: httpsUrl(checkpoint.resource_url, "Marketplace resource URL"),
    listing_ref: listingReference(checkpoint.listing_ref),
  });
}

function completionEvidence(checkpoint, readback, state) {
  return Object.freeze({
    schema: "runx.marketplace_vendor_readback_evidence.v1",
    listing_ref: checkpoint.listing_ref,
    payment_ref: checkpoint.payment_ref,
    invocation_id: checkpoint.invocation_id,
    state,
    transaction: boundedText(readback.transaction, 128, "Settlement transaction"),
    payment_required_digest: digest(readback.payment_required_digest),
    payment_response_digest: digest(readback.payment_response_digest),
    ...(readback.inner_receipt_ref === undefined
      ? {}
      : { inner_receipt_ref: receiptReference(readback.inner_receipt_ref) }),
  });
}

function actionOf(value, kind) {
  const action = record(value, "Marketplace readback action");
  if (action.kind !== kind) throw new Error("Marketplace readback action changed branch.");
  return action;
}

function providerJobReference(invocationId) {
  return Object.freeze({
    type: "target",
    uri: `runx:x402-invocation:${encodeURIComponent(invocationId)}`,
  });
}

function readbackEvidenceReference(providerJobRef) {
  const reference = targetReference(providerJobRef);
  return Object.freeze({ type: "verification", uri: `${reference.uri}#readback` });
}

function targetReference(value) {
  const reference = record(value, "Provider job reference");
  if (reference.type !== "target"
    || typeof reference.uri !== "string"
    || !reference.uri.startsWith("runx:x402-invocation:")) {
    throw new Error("Marketplace provider job reference is invalid.");
  }
  return Object.freeze({ type: "target", uri: reference.uri });
}

function artifactReference(value) {
  const uri = boundedText(value, 256, "Artifact reference");
  if (!uri.startsWith("runx:artifact:")) throw new Error("Artifact reference is invalid.");
  return Object.freeze({ type: "artifact", uri });
}

function receiptReference(value) {
  const uri = boundedText(value, 500, "Receipt reference");
  if (!uri.startsWith("runx:receipt:")) throw new Error("Receipt reference is invalid.");
  return uri;
}

function listingReference(value) {
  const uri = boundedText(value, 512, "Listing reference");
  if (!uri.startsWith("runx:listing:")) throw new Error("Listing reference is invalid.");
  return uri;
}

function httpsUrl(value, label) {
  const url = boundedText(value, 2_048, label);
  if (!/^https:\/\/[^/?#@\s]+(?:[/?][^#\s]*)?$/u.test(url)) {
    throw new Error(`${label} is invalid.`);
  }
  return url;
}

function recordOrArray(value) {
  return value !== null && typeof value === "object";
}

function digest(value) {
  const result = boundedText(value, 71, "SHA-256 digest");
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new Error("SHA-256 digest is invalid.");
  return result;
}

function boundedText(value, maximum, label) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}
