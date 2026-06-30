import fs from "node:fs";

const inputs = readInputs();

try {
  const result = decide(inputs);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(64);
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function decide(raw) {
  const contractText = requireString(raw.contract_text, "contract_text");
  const vendor = requireObject(raw.vendor_context, "vendor_context");
  const policy = requireObject(raw.policy, "policy");
  const dataSourceRef = requireString(raw.data_source_ref, "data_source_ref");
  const storeId = requireString(raw.store_id, "store_id");

  const vendorRef = requireString(vendor.vendor_ref, "vendor_context.vendor_ref");
  requireString(vendor.history, "vendor_context.history");
  requireString(vendor.industry, "vendor_context.industry");

  const policyId = requireString(policy.policy_id, "policy.policy_id");
  const createdAt = requireString(policy.created_at, "policy.created_at");
  const requiredSlaTerms = requireObject(policy.required_sla_terms, "policy.required_sla_terms");
  const minUptime = requireNumber(requiredSlaTerms.min_uptime_percent, "policy.required_sla_terms.min_uptime_percent");
  const supportResponseHours = requireNumber(requiredSlaTerms.support_response_hours, "policy.required_sla_terms.support_response_hours");
  const maxLiability = requireNumber(policy.max_liability, "policy.max_liability");
  const dataHandlingFloor = requireStringArray(policy.data_handling_floor, "policy.data_handling_floor");
  const terminationWindow = requireNumber(policy.termination_window, "policy.termination_window");
  const priorVersion = readPriorVersion(raw.prior_risk_record);

  const normalized = normalize(contractText);
  const gaps = [];
  const rejectionReasons = [];
  const evidence = [];

  const uptime = extractUptime(normalized);
  if (uptime !== null && uptime < minUptime) {
    gaps.push(condition("sla_uptime_below_floor", "SLA uptime is below the trust policy floor", "policy.required_sla_terms.min_uptime_percent", { observed_uptime_percent: uptime, min_uptime_percent: minUptime }));
  }
  if (uptime === null) {
    gaps.push(condition("sla_uptime_missing", "SLA uptime is not explicit", "policy.required_sla_terms.min_uptime_percent", { min_uptime_percent: minUptime }));
  }

  const terminationDays = extractTerminationDays(normalized);
  if (terminationDays !== null && terminationDays > terminationWindow) {
    gaps.push(condition("termination_notice_above_window", "Termination notice exceeds policy window", "policy.termination_window", { observed_days: terminationDays, termination_window: terminationWindow }));
  }

  const missingDataTerms = dataHandlingFloor.filter((term) => !hasPositivePolicyTerm(normalized, term));
  if (missingDataTerms.length > 0) {
    rejectionReasons.push(condition("data_handling_below_floor", "Contract does not meet required data-handling floor", "policy.data_handling_floor", { missing_terms: missingDataTerms }));
  }

  const liability = extractLiability(normalized);
  if (liability.unbounded || (liability.amount !== null && liability.amount > maxLiability)) {
    rejectionReasons.push(condition("liability_above_policy_cap", "Liability is unbounded or above policy cap", "policy.max_liability", { observed_liability: liability.unbounded ? "unbounded" : liability.amount, max_liability: maxLiability }));
  }

  evidence.push({ policy_field: "policy.required_sla_terms.support_response_hours", value: supportResponseHours });
  evidence.push({ policy_field: "policy.policy_id", value: policyId });
  evidence.push({ policy_field: "policy.created_at", value: createdAt });

  const rejected = rejectionReasons.length > 0;
  const approved = !rejected;
  const conditions = approved ? gaps : [];
  const reason = rejected
    ? rejectionReasons.map((item) => item.code).join(", ")
    : conditions.length > 0
      ? "approved with conditions"
      : "approved";

  const decision = {
    approved,
    rejected,
    reason,
    conditions,
    rejection_reasons: rejectionReasons,
    policy_id: policyId,
    created_at: createdAt,
  };

  const riskRecordEvent = {
    schema: "runx.vendor_risk_record.v1",
    vendor_ref: vendorRef,
    decision,
    policy_id: policyId,
    created_at: createdAt,
    data_source_ref: dataSourceRef,
  };

  const idempotencyKey = stableKey([vendorRef, policyId, rejected ? "rejected" : "approved", reason]);
  const appendEvent = {
    package: "registry:runx/data-store@0.1.2",
    operation: "append_event",
    store_id: storeId,
    aggregate_id: vendorRef,
    expected_version: priorVersion,
    before_version: priorVersion,
    after_version: priorVersion + 1,
    idempotency_key: idempotencyKey,
    event: riskRecordEvent,
  };

  return {
    decision,
    risk_record_event: riskRecordEvent,
    data_store_append_event: appendEvent,
    record_written: true,
    escalation: null,
    evidence_summary: {
      vendor_ref: vendorRef,
      policy_id: policyId,
      created_at: createdAt,
      contract_gaps: gaps,
      rejection_reasons: rejectionReasons,
      data_store: { store_id: storeId, before_version: priorVersion, after_version: priorVersion + 1, idempotency_key: idempotencyKey },
      grounded_policy_fields: evidence,
    },
  };
}

function condition(code, reason, policyField, evidence) {
  return { code, reason, policy_field: policyField, evidence };
}

function extractUptime(text) {
  const match = text.match(/(\d{2}\.\d|\d{2})\s*(?:percent|%)/);
  return match ? Number(match[1]) : null;
}

function extractTerminationDays(text) {
  const match = text.match(/(\d+)\s*day\s*termination/);
  return match ? Number(match[1]) : null;
}

function extractLiability(text) {
  if (/unlimited liability|liability is unlimited|unbounded liability/.test(text)) {
    return { unbounded: true, amount: null };
  }
  const match = text.match(/liability (?:capped at|cap|is capped at) usd\s*(\d+)/);
  return { unbounded: false, amount: match ? Number(match[1]) : null };
}

function hasPositivePolicyTerm(text, term) {
  const normalizedTerm = normalize(term);
  if (!text.includes(normalizedTerm)) return false;
  const negatedPatterns = [
    `without ${normalizedTerm}`,
    `no ${normalizedTerm}`,
    `${normalizedTerm} not guaranteed`,
    `${normalizedTerm} is not guaranteed`,
  ];
  return !negatedPatterns.some((pattern) => text.includes(pattern));
}

function readPriorVersion(value) {
  if (value === undefined || value === null) return 0;
  const record = requireObject(value, "prior_risk_record");
  return requireNumber(record.version, "prior_risk_record.version");
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${name} must be a finite number`);
  }
  return number;
}

function requireStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${name} must be a string array`);
  }
  return value;
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
}

function stableKey(parts) {
  return `vendor-risk:${parts.map((part) => normalize(part)).join(":")}`;
}
