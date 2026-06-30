import fs from "node:fs";
import crypto from "node:crypto";

function parseInputValue(raw) {
  if (raw == null || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  const envInputs = {
    request_packet: parseInputValue(process.env.RUNX_INPUT_REQUEST_PACKET),
    requestor_proof: parseInputValue(process.env.RUNX_INPUT_REQUESTOR_PROOF),
    policy: parseInputValue(process.env.RUNX_INPUT_POLICY),
    data_source_ref: parseInputValue(process.env.RUNX_INPUT_DATA_SOURCE_REF),
    store_id: parseInputValue(process.env.RUNX_INPUT_STORE_ID),
    expected_version: parseInputValue(process.env.RUNX_INPUT_EXPECTED_VERSION),
  };
  if (Object.values(envInputs).some((value) => value !== undefined)) {
    return envInputs;
  }
  const stdin = fs.readFileSync(0, "utf8").trim();
  return stdin ? JSON.parse(stdin) : {};
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value == null || value === "") return [];
  return [String(value)];
}

function stableScope(scope) {
  return normalizeArray(scope).map((item) => item.trim()).filter(Boolean).sort();
}

function lawfulBasesFor(policy, type) {
  const bases = policy?.lawful_bases ?? {};
  const direct = bases[type];
  return normalizeArray(direct);
}

function decide(inputs) {
  const request = inputs.request_packet ?? {};
  const proof = inputs.requestor_proof ?? {};
  const policy = inputs.policy ?? {};
  const requestType = String(request.type ?? "").trim();
  const subjectId = String(request.subject_id ?? "").trim();
  const requestId = String(request.request_id ?? `${requestType || "request"}-${subjectId || "unknown"}`).trim();
  const scope = stableScope(request.scope);
  const scopeBounds = stableScope(policy.scope_bounds);
  const trustedProviders = new Set(normalizeArray(policy.trusted_identity_providers));
  const identityProvider = String(proof.identity_provider ?? "").trim();
  const verifiedAt = String(proof.verified_at ?? "").trim();
  const assertion = String(proof.assertion ?? "").trim();
  const jurisdiction = String(policy.jurisdiction ?? "").trim();
  const dataSourceRef = String(inputs.data_source_ref ?? "").trim();
  const storeId = String(inputs.store_id ?? "").trim();
  const expectedVersion = Number.isFinite(Number(inputs.expected_version))
    ? Number(inputs.expected_version)
    : 0;
  const aggregateId = `subject-request:${subjectId || "unknown"}:${requestId || "unknown"}`;
  const lawfulBases = lawfulBasesFor(policy, requestType);
  const outOfBounds = scope.filter((item) => !scopeBounds.includes(item));
  const proofTrusted = identityProvider && trustedProviders.has(identityProvider) && verifiedAt && assertion;
  const reasons = [];

  if (!requestType) reasons.push("missing request_packet.type");
  if (!subjectId) reasons.push("missing request_packet.subject_id");
  if (scope.length === 0) reasons.push("missing request_packet.scope");
  if (!jurisdiction) reasons.push("missing policy.jurisdiction");
  if (!dataSourceRef) reasons.push("missing data_source_ref");
  if (!storeId) reasons.push("missing store_id");
  if (!proofTrusted) {
    reasons.push(`requestor proof is not trusted for ${jurisdiction || "unknown jurisdiction"}`);
  }
  if (lawfulBases.length === 0) {
    reasons.push(`no lawful basis configured for ${requestType || "unknown"} in ${jurisdiction || "unknown jurisdiction"}`);
  }
  if (outOfBounds.length > 0) {
    reasons.push(`scope outside policy bounds: ${outOfBounds.join(", ")}`);
  }

  const eligible = reasons.length === 0;
  const scopeDigest = sha256(scope.join("|")).slice(0, 16);
  const assertionDigest = assertion.startsWith("sha256:")
    ? assertion
    : assertion
      ? `sha256:${sha256(assertion)}`
      : "";
  const idempotencyKey = `dsr:${subjectId || "unknown"}:${requestId || "unknown"}:${requestType || "unknown"}:${scopeDigest}:${eligible ? "eligible" : "refused"}:v1`;
  const lawfulBasis = lawfulBases[0] ?? null;
  const decision = {
    eligible,
    reason: eligible
      ? `${jurisdiction} ${requestType} request is eligible under ${lawfulBasis}; requestor proof is trusted and scope is bounded.`
      : `Request refused: ${reasons.join("; ")}.`,
    jurisdiction,
    lawful_basis: lawfulBasis,
    request_type: requestType,
    subject_id: subjectId,
    data_classes: scope,
  };

  const handoff = eligible
    ? requestType === "erasure"
      ? {
          path: "downstream:data-store:append_event:subject.erasure_tombstone",
          subject_id: subjectId,
          data_classes: scope,
          scopes: scope,
          downstream_run: "governed-erasure-tombstone",
          human_approval_required: true,
          effect_fired_by_this_skill: false,
        }
      : {
          path: "downstream:read_projection:redact-pii:send-as",
          subject_id: subjectId,
          data_classes: scope,
          scopes: scope,
          downstream_run: "governed-subject-export",
          human_approval_required: true,
          effect_fired_by_this_skill: false,
        }
    : null;

  const escalation = eligible
    ? {
        required: false,
        lane: null,
        reason: "bounded handoff emitted as data; downstream effect still requires separate governed approval",
      }
    : {
        required: true,
        lane: "human_privacy_approval",
        reason: reasons.join("; "),
        no_handoff: true,
      };

  const event = {
    type: "subject_request.verdict.recorded",
    schema: "runx.data_subject_request.verdict.v1",
    payload: {
      request_id: requestId,
      request_type: requestType,
      subject_id: subjectId,
      eligible,
      reason: decision.reason,
      jurisdiction,
      lawful_basis: lawfulBasis,
      data_classes: scope,
      identity_provider: identityProvider || null,
      identity_assertion_digest: assertionDigest || null,
      handoff_path: handoff?.path ?? null,
      refused_reasons: eligible ? [] : reasons,
    },
  };

  const dataStore = {
    dependency: "registry:runx/data-store@0.1.2",
    store_id: storeId,
    aggregate_id: aggregateId,
    resource: "subject_request_decisions",
    sequence: ["read_projection", "decide", "append_event"],
    read_projection: {
      operation: "read_projection",
      data_source_ref: dataSourceRef,
      store_id: storeId,
      resource: "subject_request_decisions",
      aggregate_id: aggregateId,
    },
    append_event: {
      operation: "append_event",
      data_source_ref: dataSourceRef,
      store_id: storeId,
      resource: "subject_request_decisions",
      aggregate_id: aggregateId,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
      event,
      gated: false,
      write_kind: "ungated_cas_verdict_record",
    },
    downstream_consequence: eligible
      ? "dispatch-by-naming only; separate governed downstream run required"
      : "no handoff; human approval lane for identity or scope dispute",
  };

  const evidence = {
    lawful_basis_verdict: {
      eligible,
      jurisdiction,
      lawful_basis: lawfulBasis,
      reason: decision.reason,
    },
    requestor_ref: proof.requestor_ref ?? null,
    identity_provider: identityProvider || null,
    identity_assertion_digest: assertionDigest || null,
    trusted_identity_provider: Boolean(proofTrusted),
    scope_bounds: scopeBounds,
    requested_scope: scope,
    bounded_handoff_applied: eligible ? handoff : null,
    aggregate_id: aggregateId,
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    refused_reason: eligible ? null : reasons.join("; "),
    no_operational_proposal_envelope: true,
    no_delete_or_export_performed: true,
    no_send_performed: true,
  };

  const status = eligible ? "sealed" : "refused";
  const result = {
    status,
    decision,
    handoff,
    escalation,
    data_store: dataStore,
    evidence,
  };
  result.data_subject_request = {
    status,
    decision,
    handoff,
    escalation,
    data_store: dataStore,
    evidence,
  };
  return result;
}

const inputs = readInputs();
const output = decide(inputs);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
