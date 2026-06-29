import fs from "node:fs";
import crypto from "node:crypto";

const inputs = readInputs();

const request = object(inputs.request_packet, "request_packet");
const proof = object(inputs.requestor_proof, "requestor_proof");
const policy = object(inputs.policy, "policy");
const dataSourceRef = requiredText(inputs.data_source_ref, "data_source_ref");
const storeId = requiredText(inputs.store_id, "store_id");
const aggregateId = requiredText(inputs.aggregate_id, "aggregate_id");
const expectedVersion = number(inputs.expected_version, "expected_version");
const idempotencyKey = requiredText(inputs.idempotency_key, "idempotency_key");

const type = requiredText(request.type, "request_packet.type").toLowerCase();
const subjectId = requiredText(request.subject_id, "request_packet.subject_id");
const requestedScope = arrayOfText(request.scope, "request_packet.scope");
const jurisdiction = requiredText(policy.jurisdiction, "policy.jurisdiction");
const scopeBounds = arrayOfText(policy.scope_bounds, "policy.scope_bounds");
const lawfulBases = object(policy.lawful_bases, "policy.lawful_bases");

const proofDigest = digest({
  identity_provider: text(proof.identity_provider),
  verified_at: text(proof.verified_at),
  assertion: text(proof.assertion),
});

const issues = [];
if (!["erasure", "export"].includes(type)) {
  issues.push(`unsupported request type '${type}'`);
}
if (!isVerified(proof)) {
  issues.push(`unverified requestor for ${jurisdiction}: identity_provider, verified_at, and assertion are required`);
}

const outsideScope = requestedScope.filter((item) => !scopeBounds.includes(item));
if (outsideScope.length) {
  issues.push(`scope outside ${jurisdiction} policy bounds: ${outsideScope.join(", ")}`);
}

const lawfulBasisVerdict = {};
for (const item of requestedScope) {
  const basis = text(lawfulBases[item]);
  lawfulBasisVerdict[item] = {
    lawful_basis: basis || null,
    in_scope_bounds: scopeBounds.includes(item),
    permitted_for_decision: Boolean(basis) && scopeBounds.includes(item),
  };
  if (!basis) issues.push(`missing lawful basis for ${item} under ${jurisdiction}`);
}

const eligible = issues.length === 0;
const reason = eligible
  ? `${jurisdiction} ${type} request is eligible: verified requestor and all requested classes are inside policy bounds with declared lawful bases.`
  : `${jurisdiction} ${type} request refused: ${issues.join("; ")}.`;

const decision = { eligible, reason };
const handoff = eligible
  ? {
      path: `handoff/dsr/${safe(subjectId)}/${type}.json`,
      subject_id: subjectId,
      data_classes: requestedScope,
      scopes: requestedScope.map((item) => ({
        data_class: item,
        lawful_basis: lawfulBases[item],
        operation: type,
      })),
    }
  : null;

const verdictEvent = {
  type: "data_subject_request.verdict_recorded",
  request_type: type,
  subject_id: subjectId,
  jurisdiction,
  decision,
  requested_scope: requestedScope,
  scope_bounds: scopeBounds,
  lawful_basis_verdict: lawfulBasisVerdict,
  requestor: {
    identity_provider: text(proof.identity_provider) || null,
    verified_at: text(proof.verified_at) || null,
    assertion_digest: proofDigest,
  },
  handoff_path: handoff?.path || null,
};

if (!eligible) {
  fail(reason, {
    decision,
    escalation: buildEscalation(eligible, issues, jurisdiction),
    data_store: buildDataStore(verdictEvent),
    evidence: buildEvidence(proofDigest, lawfulBasisVerdict, issues),
  });
}

emit({
  decision,
  handoff,
  escalation: buildEscalation(eligible, [], jurisdiction),
  data_store: buildDataStore(verdictEvent),
  evidence: buildEvidence(proofDigest, lawfulBasisVerdict, []),
});

function buildDataStore(event) {
  return {
    dependency: "registry:runx/data-store@0.1.2",
    sequence: ["read_projection", "decide", "append_event"],
    read_projection: {
      data_source_ref: dataSourceRef,
      store_id: storeId,
      resource: "data_subject_requests",
      aggregate_id: aggregateId,
    },
    append_event: {
      data_source_ref: dataSourceRef,
      store_id: storeId,
      resource: "data_subject_requests",
      aggregate_id: aggregateId,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
      event,
    },
  };
}

function buildEvidence(assertionDigest, verdict, issuesList) {
  return {
    jurisdiction,
    request_type: type,
    verified_requestor_ref: text(proof.identity_provider) || null,
    assertion_digest: assertionDigest,
    scope_bounds: scopeBounds,
    lawful_basis_verdict: verdict,
    aggregate_id: aggregateId,
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    refused_reason: issuesList.length ? issuesList.join("; ") : null,
    receipt_notes: [
      "decision recorded as append_event-ready verdict",
      "no erasure/export rail fired by this skill",
      "handoff emitted only when eligible",
    ],
  };
}

function buildEscalation(ok, issuesList, zone) {
  return {
    required: !ok,
    jurisdiction: zone,
    reason: ok ? "No escalation required before downstream approved processor." : issuesList.join("; "),
    no_operational_rail_fired: true,
    downstream_approval_required: true,
  };
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
    aggregate_id: parseInputValue(process.env.RUNX_INPUT_AGGREGATE_ID),
    expected_version: parseInputValue(process.env.RUNX_INPUT_EXPECTED_VERSION),
    idempotency_key: parseInputValue(process.env.RUNX_INPUT_IDEMPOTENCY_KEY),
  };
  if (Object.values(envInputs).some((value) => value !== undefined)) {
    return envInputs;
  }
  const raw = fs.readFileSync(0, "utf8");
  return JSON.parse(raw);
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredText(value, label) {
  const out = text(value);
  if (!out) fail(`${label} is required`);
  return out;
}

function arrayOfText(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const out = value.map(text).filter(Boolean);
  if (!out.length) fail(`${label} must contain at least one item`);
  return out;
}

function number(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a number`);
  return value;
}

function isVerified(value) {
  return Boolean(text(value.identity_provider) && text(value.verified_at) && text(value.assertion));
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function safe(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, details = null) {
  if (details) {
    process.stderr.write(`${JSON.stringify({ error: message, ...details }, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(2);
}
