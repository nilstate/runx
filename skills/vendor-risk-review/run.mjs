import fs from "node:fs";
import crypto from "node:crypto";

const inputs = readInputs();

const contractText = requiredText(inputs.contract_text, "contract_text");
const vendorContext = object(inputs.vendor_context, "vendor_context");
const policy = object(inputs.policy, "policy");
const dataSourceRef = requiredText(inputs.data_source_ref, "data_source_ref");
const storeId = requiredText(inputs.store_id, "store_id");

const vendorRef = text(vendorContext.vendor_ref);
const industry = text(vendorContext.industry) || "unspecified";
const history = objectOrNull(vendorContext.history);
const requiredSlaTerms = Array.isArray(policy.required_sla_terms)
  ? policy.required_sla_terms.map(text).filter(Boolean)
  : [];
const maxLiability = finiteNumber(policy.max_liability) ? Number(policy.max_liability) : null;
const dataHandlingFloor = text(policy.data_handling_floor);
const terminationWindow = text(policy.termination_window);
const policyId = text(policy.policy_id);
const createdAt = text(policy.created_at);

const stopReasons = [];
if (!vendorRef) stopReasons.push("ambiguous vendor: vendor_context.vendor_ref is required");
if (!history || !finiteNumber(history.current_version)) {
  stopReasons.push("unreadable prior state: vendor_context.history.current_version is required");
}
if (!requiredSlaTerms.length) stopReasons.push("policy.required_sla_terms must include at least one term");
if (!finiteNumber(maxLiability)) stopReasons.push("policy.max_liability must be numeric");
if (!dataHandlingFloor) stopReasons.push("policy.data_handling_floor is required");
if (!terminationWindow) stopReasons.push("policy.termination_window is required");
if (!policyId) stopReasons.push("policy.policy_id is required");
if (!createdAt) stopReasons.push("policy.created_at is required");

const normalized = normalize(contractText);
const contractDigest = digest(contractText);
const expectedVersion = finiteNumber(history?.current_version) ? Number(history.current_version) : 0;

if (stopReasons.length) {
  emit(buildStop(stopReasons));
}

const hardFindings = [];
const recoverableConditions = [];

const liabilityFinding = liabilityRisk(normalized, maxLiability);
if (liabilityFinding.block) hardFindings.push(liabilityFinding.reason);

const dataFinding = dataHandlingRisk(normalized, dataHandlingFloor);
if (dataFinding.block) hardFindings.push(dataFinding.reason);

for (const term of requiredSlaTerms) {
  if (!includesTerm(normalized, term)) {
    recoverableConditions.push(`Add SLA term required by ${policyId}: ${term}.`);
  }
}

if (terminationWindow && !includesTerm(normalized, terminationWindow)) {
  recoverableConditions.push(`Add termination language matching policy window: ${terminationWindow}.`);
}

const rejected = hardFindings.length > 0;
const approved = !rejected;
const reason = rejected
  ? `Rejected under ${policyId}: ${hardFindings.join("; ")}.`
  : recoverableConditions.length
    ? `Approved with conditions under ${policyId}: recoverable gaps must be remediated before procurement completion.`
    : `Approved under ${policyId}: contract meets liability, data-handling, SLA, and termination checks.`;

const decision = {
  approved,
  reason,
  conditions: approved ? recoverableConditions : [],
  rejected,
};

const riskEvent = {
  type: "vendor_risk_review.decision_recorded",
  vendor_ref: vendorRef,
  industry,
  decision,
  conditions: decision.conditions,
  policy_id: policyId,
  created_at: createdAt,
  findings: {
    hard_blocks: hardFindings,
    recoverable_conditions: recoverableConditions,
    liability: liabilityFinding,
    data_handling: dataFinding,
  },
  contract_digest: contractDigest,
};

const idempotencyKey = stableKey([vendorRef, policyId, rejected ? "rejected" : "approved", digest(decision).slice(7, 23)]);

emit({
  decision,
  risk_record: riskEvent,
  data_store: {
    dependency: "registry:runx/data-store@0.1.2",
    sequence: ["read_projection", "decide", "append_event"],
    read_projection: {
      data_source_ref: dataSourceRef,
      store_id: storeId,
      resource: "vendor_risk_records",
      aggregate_id: vendorRef,
    },
    append_event: {
      data_source_ref: dataSourceRef,
      store_id: storeId,
      resource: "vendor_risk_records",
      aggregate_id: vendorRef,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
      event: riskEvent,
    },
  },
  escalation: {
    required: false,
    lane: null,
    no_stakeholder_notify: true,
    no_receipt_ledger_state_read: true,
  },
  evidence: {
    package: "vendor-risk-review",
    policy_id: policyId,
    vendor_ref: vendorRef,
    contract_digest: contractDigest,
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    rules_applied: [
      "reject unbounded or above-policy liability",
      "reject data handling below policy floor",
      "approve with conditions for recoverable SLA/termination gaps",
      "stop before write for ambiguous vendor or incomplete policy",
    ],
    write_performed_by_skill: false,
    append_event_ready: true,
  },
});

function buildStop(reasons) {
  const decision = {
    approved: false,
    reason: `Stopped before risk-record write: ${reasons.join("; ")}.`,
    conditions: [],
    rejected: false,
  };
  return {
    decision,
    risk_record: null,
    data_store: {
      dependency: "registry:runx/data-store@0.1.2",
      sequence: ["read_projection", "decide", "stop_before_append_event"],
      read_projection: vendorRef
        ? {
            data_source_ref: dataSourceRef,
            store_id: storeId,
            resource: "vendor_risk_records",
            aggregate_id: vendorRef,
          }
        : null,
      append_event: null,
      no_write_reason: reasons.join("; "),
    },
    escalation: {
      required: true,
      lane: "human_approval",
      reason: reasons.join("; "),
      no_stakeholder_notify: true,
      no_receipt_ledger_state_read: true,
    },
    evidence: {
      package: "vendor-risk-review",
      policy_id: policyId || null,
      vendor_ref: vendorRef || null,
      contract_digest: contractDigest,
      stop_reasons: reasons,
      append_event_ready: false,
      write_performed_by_skill: false,
    },
  };
}

function liabilityRisk(textValue, cap) {
  if (/(unlimited|uncapped|unbounded)\s+liability|liability\s+(is\s+)?(unlimited|uncapped|unbounded)|waives?\s+any\s+liability\s+cap/.test(textValue)) {
    return { block: true, reason: `unbounded liability exceeds policy max_liability ${cap}` };
  }
  const amounts = [...textValue.matchAll(/(?:usd|\$)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g)]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter((value) => Number.isFinite(value));
  const maxSeen = amounts.length ? Math.max(...amounts) : null;
  if (maxSeen !== null && maxSeen > cap) {
    return { block: true, reason: `liability amount ${maxSeen} exceeds policy max_liability ${cap}`, observed_amount: maxSeen };
  }
  return { block: false, reason: "liability appears bounded within policy", observed_amount: maxSeen };
}

function dataHandlingRisk(textValue, floor) {
  const floorRank = tierRank(floor);
  const observed = observedDataTier(textValue);
  if (observed.rank < floorRank) {
    return {
      block: true,
      reason: `data handling '${observed.label}' is below policy floor '${floor}'`,
      observed: observed.label,
      required: floor,
    };
  }
  return { block: false, reason: `data handling '${observed.label}' meets policy floor '${floor}'`, observed: observed.label, required: floor };
}

function observedDataTier(textValue) {
  const tiers = [
    ["hipaa", 6],
    ["iso 27001", 5],
    ["iso27001", 5],
    ["soc2", 4],
    ["soc 2", 4],
    ["enhanced", 3],
    ["standard", 2],
    ["basic", 1],
  ];
  for (const [label, rank] of tiers) {
    if (textValue.includes(label)) return { label, rank };
  }
  return { label: "unspecified", rank: 0 };
}

function tierRank(value) {
  return observedDataTier(normalize(String(value))).rank || (normalize(String(value)) === "soc2" ? 4 : 0);
}

function includesTerm(textValue, term) {
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return true;
  if (textValue.includes(normalizedTerm)) return true;
  const words = normalizedTerm.split(/\s+/).filter((word) => word.length > 3);
  return words.length > 0 && words.every((word) => textValue.includes(word));
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function stableKey(parts) {
  return parts.map((part) => String(part).replace(/[^a-zA-Z0-9_.:-]/g, "_")).join(":");
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  const envInputs = {
    contract_text: parseInputValue(process.env.RUNX_INPUT_CONTRACT_TEXT),
    vendor_context: parseInputValue(process.env.RUNX_INPUT_VENDOR_CONTEXT),
    policy: parseInputValue(process.env.RUNX_INPUT_POLICY),
    data_source_ref: parseInputValue(process.env.RUNX_INPUT_DATA_SOURCE_REF),
    store_id: parseInputValue(process.env.RUNX_INPUT_STORE_ID),
  };
  if (Object.values(envInputs).some((value) => value !== undefined)) return envInputs;
  return JSON.parse(fs.readFileSync(0, "utf8"));
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

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredText(value, label) {
  const out = text(value);
  if (!out) fail(`${label} is required`);
  return out;
}

function finiteNumber(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
  process.exit(2);
}
