import crypto from "node:crypto";
import fs from "node:fs";

const inputs = readInputs();
const requestPacket = objectValue(inputs.request_packet, "request_packet");
const requestorProof = objectValue(inputs.requestor_proof, "requestor_proof");
const policy = objectValue(inputs.policy, "policy");
const aggregateId = stringValue(inputs.aggregate_id);
const expectedVersion = numberValue(inputs.expected_version);
const idempotencyKey = stringValue(inputs.idempotency_key);
const priorDecision = inputs.prior_decision && typeof inputs.prior_decision === "object" && !Array.isArray(inputs.prior_decision)
  ? inputs.prior_decision
  : null;

if (!aggregateId) fail("aggregate_id is required");
if (expectedVersion === undefined) fail("expected_version is required");
if (!idempotencyKey) fail("idempotency_key is required");

const requestType = stringValue(requestPacket.type);
const subjectId = stringValue(requestPacket.subject_id);
const scope = objectValue(requestPacket.scope, "request_packet.scope");
const requestId = stringValue(scope.request_id) ?? "request:unspecified";
const requestedClasses = uniqueStrings(scope.data_classes ?? scope.requested_scopes);
const requestedScopes = uniqueStrings(scope.requested_scopes ?? scope.data_classes);
const jurisdiction = stringValue(policy.jurisdiction) ?? "unspecified";
const lawfulBases = objectValue(policy.lawful_bases, "policy.lawful_bases");
const scopeBounds = objectValue(policy.scope_bounds, "policy.scope_bounds");
const allowedClasses = uniqueStrings(scopeBounds.data_classes);
const allowedForType = uniqueStrings(requestType === "export" ? scopeBounds.export_allowed : scopeBounds.erasure_allowed);
const trustedProviders = uniqueStrings(policy.trusted_identity_providers);
const assertion = requestorProof.assertion && typeof requestorProof.assertion === "object"
  ? requestorProof.assertion
  : {};
const identityProvider = stringValue(requestorProof.identity_provider);
const verifiedAt = stringValue(requestorProof.verified_at);
const assertionSubject = stringValue(assertion.subject_id);
const assertionRef = stringValue(assertion.assertion_ref) ?? `${identityProvider ?? "unknown"}:${subjectId ?? "unknown"}`;
const assertionDigest = stringValue(assertion.assertion_digest) ?? digestObject(assertion);
const lawfulBasis = requestType ? stringValue(lawfulBases[requestType]) : null;

const refusalReasons = [];
if (!["erasure", "export"].includes(requestType ?? "")) {
  refusalReasons.push("request type must be erasure or export");
}
if (!subjectId) {
  refusalReasons.push("request_packet.subject_id is missing");
}
if (requestedClasses.length === 0) {
  refusalReasons.push("request scope has no data_classes or requested_scopes");
}
if (!identityProvider) {
  refusalReasons.push("requestor identity_provider is missing");
} else if (!trustedProviders.includes(identityProvider)) {
  refusalReasons.push(`identity_provider ${identityProvider} is not trusted for ${jurisdiction}`);
}
if (!verifiedAt || Number.isNaN(Date.parse(verifiedAt))) {
  refusalReasons.push("requestor proof has no valid verified_at timestamp");
}
if (!assertionSubject || assertionSubject !== subjectId) {
  refusalReasons.push("requestor assertion does not bind to the requested subject_id");
}
if (!assertionDigest.startsWith("sha256:")) {
  refusalReasons.push("requestor assertion digest is missing or not sha256-prefixed");
}
if (!lawfulBasis) {
  refusalReasons.push(`no lawful basis supplied for ${requestType ?? "unknown"} under ${jurisdiction}`);
}
for (const dataClass of requestedClasses) {
  if (!allowedClasses.includes(dataClass)) {
    refusalReasons.push(`requested data class ${dataClass} is outside policy.scope_bounds.data_classes`);
  }
  if (!allowedForType.includes(dataClass)) {
    refusalReasons.push(`requested data class ${dataClass} is outside ${requestType ?? "request"}_allowed bounds`);
  }
}

const eligible = refusalReasons.length === 0;
const handoff = eligible
  ? buildHandoff({ requestType, subjectId, requestedClasses, requestedScopes })
  : null;
const reason = eligible
  ? `${jurisdiction} ${requestType} request is eligible: verified ${identityProvider} proof matches ${subjectId}, lawful basis is supplied, and scope is bounded to ${requestedClasses.join(", ")}.`
  : `${jurisdiction} ${requestType ?? "request"} refused: ${refusalReasons.join("; ")}.`;
const decision = { eligible, reason };
const escalation = eligible
  ? {
      required: false,
      lane: "none",
      reason: "Requestor identity, subject match, lawful basis, and scope all pass policy.",
    }
  : {
      required: true,
      lane: "human_privacy_review",
      reason: reason,
    };
const observations = {
  lawful_basis_verdict: lawfulBasis
    ? `${lawfulBasis} => ${eligible ? "eligible" : "refused"}`
    : `missing lawful basis => refused`,
  jurisdiction_reason: `${jurisdiction} policy supplied for request ${requestId}.`,
  verified_requestor_ref: assertionRef,
  identity_assertion_digest: assertionDigest,
  scope_bounds: allowedClasses,
  bounded_handoff: eligible ? `${handoff.path} for ${handoff.data_classes.join(", ")} only` : "none",
  data_store_aggregate_id: aggregateId,
  expected_version: expectedVersion,
  idempotency_key: idempotencyKey,
  prior_projection_seen: priorDecision !== null,
  prior_projection_version: typeof priorDecision?.version === "number" ? priorDecision.version : null,
  refused_reason: eligible ? null : reason,
  harness_case_names: [
    "eligible-erasure-records-verdict",
    "unverified-requestor-refused-no-handoff",
  ],
};
const verdictEventPayload = {
  packet: "runx.privacy.data_subject_request.v1",
  request: {
    request_id: requestId,
    type: requestType,
    subject_id: subjectId,
    requested_scopes: requestedScopes,
    data_classes: requestedClasses,
  },
  decision,
  escalation,
  legal: {
    jurisdiction,
    lawful_basis: lawfulBasis,
  },
  requestor: {
    identity_provider: identityProvider,
    verified_at: verifiedAt,
    assertion_ref: assertionRef,
    identity_assertion_digest: assertionDigest,
  },
  scope_bounds: {
    data_classes: allowedClasses,
    requested_scopes: requestedScopes,
  },
  data_store: {
    aggregate_id: aggregateId,
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    prior_projection_seen: priorDecision !== null,
    prior_projection_version: typeof priorDecision?.version === "number" ? priorDecision.version : null,
  },
};
if (eligible) {
  verdictEventPayload.handoff = handoff;
}

const result = {
  decision,
  escalation,
  verdict_event: {
    type: "subject_request.verdict_recorded",
    payload: verdictEventPayload,
  },
  observations,
};
if (eligible) {
  result.handoff = handoff;
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function buildHandoff({ requestType, subjectId, requestedClasses, requestedScopes }) {
  if (requestType === "export") {
    return {
      path: "downstream.read_projection.redact-pii.send-as",
      subject_id: subjectId,
      data_classes: requestedClasses,
      scopes: {
        request_type: requestType,
        requested_scopes: requestedScopes,
        downstream_operator_required: true,
        read_operation: "read_projection",
        redaction_skill: "redact-pii",
        delivery_skill: "send-as",
        rail_effect: "none",
      },
    };
  }
  return {
    path: "downstream.data-store.append_event.subject.erasure",
    subject_id: subjectId,
    data_classes: requestedClasses,
    scopes: {
      request_type: requestType,
      requested_scopes: requestedScopes,
      downstream_operator_required: true,
      erasure_event_type: "subject.erasure",
      rail_effect: "none",
    },
  };
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    request_packet: parseInputValue(process.env.RUNX_INPUT_REQUEST_PACKET),
    requestor_proof: parseInputValue(process.env.RUNX_INPUT_REQUESTOR_PROOF),
    policy: parseInputValue(process.env.RUNX_INPUT_POLICY),
    aggregate_id: parseInputValue(process.env.RUNX_INPUT_AGGREGATE_ID),
    expected_version: parseInputValue(process.env.RUNX_INPUT_EXPECTED_VERSION),
    idempotency_key: parseInputValue(process.env.RUNX_INPUT_IDEMPOTENCY_KEY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()))];
}

function digestObject(value) {
  return `sha256:${crypto.createHash("sha256").update(canon(value ?? {}), "utf8").digest("hex")}`;
}

function canon(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canon).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(",")}}`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
