import fs from "node:fs";

const inputs = readInputs();
const agencyRef = requiredString(inputs.agency_ref, "agency_ref");
const caseId = optionalString(inputs.case_id) ?? agencyRef;
assertAggregateId(caseId);

const period = normalizePeriod(inputs.period);
const healthBaseline = normalizeBaseline(inputs.health_baseline);

const queryPlan = {
  schema: "runx.agency_health.query.v1",
  agency_ref: agencyRef,
  case_id: caseId,
  resource: "agency_cases",
  period,
  health_baseline: healthBaseline,
  ledger_question: `Which closed/sealed or refused runs fall in the health period for agency ${agencyRef}? Return id-stubs only.`,
  ledger_filter: {
    time_range: period,
  },
  ledger_proof: {
    verify_chain: false,
  },
};

process.stdout.write(`${JSON.stringify(queryPlan, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function requiredString(value, field) {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function assertAggregateId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/.test(value)) {
    throw new Error("case_id must be a safe aggregate identifier");
  }
}

function normalizePeriod(value) {
  if (value === undefined || value === null) return { from: "", to: "" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("period must be an object with optional from and to bounds");
  }
  const from = optionalIso(value.from, "period.from");
  const to = optionalIso(value.to, "period.to");
  if (from && to && from > to) throw new Error("period.from must not be after period.to");
  return { from: from ?? "", to: to ?? "" };
}

function optionalIso(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be ISO-8601`);
  }
  return new Date(value).toISOString();
}

function normalizeBaseline(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("health_baseline must be an object");
  }
  const baseline = {};
  if (value.threshold_days_stuck !== undefined) {
    baseline.threshold_days_stuck = boundedNumber(value.threshold_days_stuck, "threshold_days_stuck", 0, 3650);
  }
  if (value.cap_pressure_pct !== undefined) {
    baseline.cap_pressure_pct = boundedNumber(value.cap_pressure_pct, "cap_pressure_pct", 0, 100);
  }
  if (value.refusal_spike_rate !== undefined) {
    baseline.refusal_spike_rate = boundedNumber(value.refusal_spike_rate, "refusal_spike_rate", 0, 1);
  }
  return baseline;
}

function boundedNumber(value, field, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a number from ${min} to ${max}`);
  }
  return value;
}
