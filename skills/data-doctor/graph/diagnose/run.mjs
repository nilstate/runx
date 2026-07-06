import fs from "node:fs";

const input = readInputs();
const dataset = input.dataset;
const schema = object(input.schema);
const fields = object(schema.fields);
const rules = object(input.quality_rules);

if (!Array.isArray(dataset) || !Object.keys(fields).length) {
  emit({ status: "refused", refused_reason: "dataset must be an array and schema.fields must be non-empty", metrics: {}, findings: [], recommendations: [], report: { status: "refused", row_count: 0 } });
  process.exit(0);
}

const malformed = dataset.map((row, index) => ({ row, index })).filter(({ row }) => !row || typeof row !== "object" || Array.isArray(row));
if (malformed.length) {
  emit({ status: "refused", refused_reason: `malformed rows at indexes: ${malformed.map(({ index }) => index).join(",")}`, metrics: {}, findings: [], recommendations: [], report: { status: "refused", row_count: dataset.length } });
  process.exit(0);
}

const findings = [];
const fieldMetrics = {};
const maxMissingRate = finite(rules.max_missing_rate) ? Number(rules.max_missing_rate) : 1;
const ranges = object(rules.ranges);

for (const [field, definitionValue] of Object.entries(fields)) {
  const definition = object(definitionValue);
  const values = dataset.map((row) => row[field]);
  const present = values.filter((value) => value !== null && value !== undefined && value !== "");
  const missingCount = values.length - present.length;
  const missingRate = dataset.length ? missingCount / dataset.length : 0;
  const uniqueCount = new Set(present.map(stableValue)).size;
  const typeDriftCount = present.filter((value) => !matchesType(value, definition.type)).length;
  fieldMetrics[field] = { missing_count: missingCount, missing_rate: round(missingRate), unique_count: uniqueCount, type_drift_count: typeDriftCount };

  if ((definition.required === true || missingRate > maxMissingRate) && missingCount > 0) addFinding(field, "missingness", round(missingRate), definition.required === true ? "error" : "warning");
  if (definition.unique === true && uniqueCount < present.length) addFinding(field, "uniqueness", { unique_count: uniqueCount, present_count: present.length }, "error");
  if (typeDriftCount > 0) addFinding(field, "type_drift", { expected: definition.type, count: typeDriftCount }, "error");

  const range = object(ranges[field]);
  if (Object.keys(range).length) {
    const numeric = present.filter((value) => typeof value === "number" && Number.isFinite(value));
    const below = finite(range.min) ? numeric.filter((value) => value < Number(range.min)).length : 0;
    const above = finite(range.max) ? numeric.filter((value) => value > Number(range.max)).length : 0;
    if (below + above > 0) addFinding(field, "range", { below_min: below, above_max: above, min: range.min ?? null, max: range.max ?? null }, "warning");
  }
}

const recommendations = findings.map((finding) => ({ field: finding.field, rule: finding.rule, action: recommendation(finding.rule) }));
emit({
  status: "complete",
  refused_reason: null,
  metrics: { row_count: dataset.length, field_count: Object.keys(fields).length, fields: fieldMetrics },
  findings,
  recommendations,
  report: { status: findings.some((finding) => finding.severity === "error") ? "unhealthy" : findings.length ? "needs_attention" : "healthy", row_count: dataset.length, finding_count: findings.length, recommendation_count: recommendations.length, dataset_mutated: false },
});

function addFinding(field, rule, observed, severity) { findings.push({ field, rule, observed, severity }); }
function recommendation(rule) {
  return ({ missingness: "Populate required values or document an allowed null policy.", uniqueness: "Resolve duplicate values before using this field as a key.", type_drift: "Normalize values to the declared schema type.", range: "Review out-of-range rows against the configured bounds." })[rule];
}
function matchesType(value, expected) {
  if (expected === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return ["string", "number", "boolean"].includes(expected) ? typeof value === expected && (expected !== "number" || Number.isFinite(value)) : true;
}
function stableValue(value) { return value && typeof value === "object" ? JSON.stringify(value) : `${typeof value}:${String(value)}`; }
function round(value) { return Math.round(value * 10000) / 10000; }
function finite(value) { return value !== null && value !== "" && Number.isFinite(Number(value)); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function emit(value) { process.stdout.write(`${JSON.stringify({ quality_report: value }, null, 2)}\n`); }
function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {};
}

