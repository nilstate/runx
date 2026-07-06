import fs from "node:fs";

const inputs = readInputs();
const currentSchema = schemaValue(inputs.current_schema, "current_schema");
const proposedSchema = schemaValue(inputs.proposed_schema, "proposed_schema");
const samplePayloads = arrayValue(inputs.sample_payloads, "sample_payloads");
const policy = policyValue(inputs.compatibility_policy);

const currentFields = normalizeFields(currentSchema.fields);
const proposedFields = normalizeFields(proposedSchema.fields);

if (Object.keys(currentFields).length === 0) fail("current_schema.fields must contain at least one field");
if (Object.keys(proposedFields).length === 0) fail("proposed_schema.fields must contain at least one field");

const breakingChanges = detectBreakingChanges(currentFields, proposedFields, policy);
const migrationNotes = buildMigrationNotes(currentFields, proposedFields, breakingChanges);
const validationResults = samplePayloads.map((sample, index) => validateSample(sample, index, currentFields, proposedFields));
const sampleUnknowns = buildSampleUnknowns(samplePayloads, currentFields, proposedFields);
const blockingValidation = validationResults.flatMap((result) => result.proposed_errors.map((error) => ({
  field_path: error.field_path,
  old_contract: "sample_payload",
  new_contract: error.reason,
  policy_rule: "sample_payloads must validate against proposed_schema before publish proposal",
  sample_index: result.sample_index,
})));
const allBreaking = [...breakingChanges, ...blockingValidation];
const compatible = allBreaking.length === 0 || policy.breaking_allowed === true;
const status = compatible ? "compatible" : "refused";
const proposal = compatible ? buildProposal({ currentSchema, proposedSchema, policy, migrationNotes, validationResults, allBreaking }) : null;

const result = {
  status,
  compatibility: {
    compatible,
    status: compatible ? "compatible" : "breaking",
    summary: compatible
      ? "Proposed schema is compatible with the supplied policy and sample evidence."
      : "Proposed schema contains breaking or unverified changes and no publish proposal was emitted.",
    breaking_changes: allBreaking,
    unknowns: sampleUnknowns,
    policy: {
      breaking_allowed: policy.breaking_allowed,
      required_fields: policy.required_fields,
      versioning_rule: policy.versioning_rule,
    },
  },
  validation_results: validationResults,
  migration_notes: migrationNotes,
  publish_schema_proposal: proposal,
  evidence: {
    side_effects: "none",
    schema_name: stringValue(proposedSchema.name) ?? stringValue(currentSchema.name) ?? "unknown",
    from_version: stringValue(currentSchema.version) ?? "unknown",
    to_version: stringValue(proposedSchema.version) ?? "unknown",
    current_field_count: Object.keys(currentFields).length,
    proposed_field_count: Object.keys(proposedFields).length,
    sample_count: samplePayloads.length,
    compatibility_status: compatible ? "compatible" : "breaking",
    breaking_changes_count: allBreaking.length,
    validation_results_count: validationResults.length,
    proposal_status: proposal ? proposal.proposal_status : "not_emitted",
    harness_case_names: ["additive-compatible-proposal", "breaking-change-refused-no-proposal", "missing-schema-failure"],
    publishes_schema: false,
    external_side_effects: "none",
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {
    current_schema: parseInputValue(process.env.RUNX_INPUT_CURRENT_SCHEMA),
    proposed_schema: parseInputValue(process.env.RUNX_INPUT_PROPOSED_SCHEMA),
    sample_payloads: parseInputValue(process.env.RUNX_INPUT_SAMPLE_PAYLOADS),
    compatibility_policy: parseInputValue(process.env.RUNX_INPUT_COMPATIBILITY_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function schemaValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  if (!value.fields || typeof value.fields !== "object" || Array.isArray(value.fields)) fail(`${name}.fields must be an object`);
  return value;
}

function arrayValue(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value;
}

function policyValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("compatibility_policy must be an object");
  return {
    breaking_allowed: value.breaking_allowed === true,
    required_fields: Array.isArray(value.required_fields) ? value.required_fields.map((field) => String(field)).filter(Boolean) : [],
    versioning_rule: stringValue(value.versioning_rule) ?? "unspecified",
  };
}

function normalizeFields(rawFields, prefix = "") {
  const fields = {};
  for (const [name, raw] of Object.entries(rawFields ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    const spec = normalizeField(raw);
    fields[path] = spec;
    if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.fields && typeof raw.fields === "object") {
      Object.assign(fields, normalizeFields(raw.fields, path));
    }
  }
  return fields;
}

function normalizeField(raw) {
  if (typeof raw === "string") return { type: raw, required: false, enum: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { type: "unknown", required: false, enum: null };
  return {
    type: stringValue(raw.type) ?? "object",
    required: raw.required === true,
    enum: Array.isArray(raw.enum) ? raw.enum.map((item) => String(item)) : null,
  };
}

function detectBreakingChanges(currentFields, proposedFields, policy) {
  const changes = [];
  for (const [path, oldSpec] of Object.entries(currentFields)) {
    const newSpec = proposedFields[path];
    if (!newSpec) {
      changes.push(change(path, oldSpec, null, oldSpec.required ? "required_field_removed" : "field_removed"));
      continue;
    }
    if (oldSpec.required && !newSpec.required) changes.push(change(path, oldSpec, newSpec, "required_field_made_optional"));
    if (oldSpec.type !== newSpec.type) changes.push(change(path, oldSpec, newSpec, "field_type_changed"));
    if (oldSpec.enum && newSpec.enum && !isSuperset(newSpec.enum, oldSpec.enum)) changes.push(change(path, oldSpec, newSpec, "enum_narrowed"));
  }
  for (const required of policy.required_fields) {
    const proposed = proposedFields[required];
    if (!proposed) changes.push(change(required, currentFields[required] ?? null, null, "policy_required_field_missing"));
    else if (!proposed.required) changes.push(change(required, currentFields[required] ?? null, proposed, "policy_required_field_not_required"));
  }
  return changes;
}

function change(path, oldSpec, newSpec, rule) {
  return {
    field_path: path,
    old_contract: oldSpec ? contractSummary(oldSpec) : "absent",
    new_contract: newSpec ? contractSummary(newSpec) : "absent",
    policy_rule: rule,
  };
}

function contractSummary(spec) {
  return {
    type: spec.type,
    required: spec.required,
    enum: spec.enum,
  };
}

function isSuperset(candidate, required) {
  return required.every((item) => candidate.includes(item));
}

function validateSample(sample, index, currentFields, proposedFields) {
  const currentErrors = validateAgainstFields(sample, currentFields);
  const proposedErrors = validateAgainstFields(sample, proposedFields);
  return {
    sample_index: index,
    valid_current: currentErrors.length === 0,
    valid_proposed: proposedErrors.length === 0,
    current_errors: currentErrors,
    proposed_errors: proposedErrors,
    missing_required: proposedErrors.filter((error) => error.kind === "missing_required").map((error) => error.field_path),
    type_mismatches: proposedErrors.filter((error) => error.kind === "type_mismatch").map((error) => ({ field_path: error.field_path, expected: error.expected, actual: error.actual })),
    enum_violations: proposedErrors.filter((error) => error.kind === "enum_violation").map((error) => ({ field_path: error.field_path, allowed: error.allowed, actual: error.actual })),
  };
}

function validateAgainstFields(sample, fields) {
  const errors = [];
  const object = sample && typeof sample === "object" && !Array.isArray(sample) ? sample : {};
  for (const [path, spec] of Object.entries(fields)) {
    const value = valueAtPath(object, path);
    if (value === undefined || value === null) {
      if (spec.required) errors.push({ kind: "missing_required", field_path: path, reason: "required field missing" });
      continue;
    }
    if (!typeMatches(value, spec.type)) errors.push({ kind: "type_mismatch", field_path: path, expected: spec.type, actual: Array.isArray(value) ? "array" : typeof value, reason: `expected ${spec.type}` });
    if (spec.enum && !spec.enum.includes(String(value))) errors.push({ kind: "enum_violation", field_path: path, allowed: spec.enum, actual: String(value), reason: "value outside allowed enum" });
  }
  return errors;
}

function valueAtPath(object, path) {
  return path.split(".").reduce((cursor, part) => cursor && typeof cursor === "object" ? cursor[part] : undefined, object);
}

function typeMatches(value, expected) {
  const type = String(expected ?? "unknown").toLowerCase();
  if (type === "string") return typeof value === "string";
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isInteger(value));
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value && typeof value === "object" && !Array.isArray(value);
  return true;
}

function buildMigrationNotes(currentFields, proposedFields, breakingChanges) {
  const notes = [];
  for (const [path, proposed] of Object.entries(proposedFields)) {
    if (!currentFields[path]) {
      notes.push({ kind: proposed.required ? "new_required_field" : "additive_field", field_path: path, note: proposed.required ? "New required field may break existing producers." : "Optional field added; existing payloads can remain valid." });
    }
  }
  for (const item of breakingChanges) {
    notes.push({ kind: "breaking_change", field_path: item.field_path, note: `Blocked by ${item.policy_rule}.` });
  }
  if (notes.length === 0) notes.push({ kind: "no_contract_delta", field_path: null, note: "No field-level schema delta detected." });
  return notes;
}

function buildSampleUnknowns(samples, currentFields, proposedFields) {
  const unknowns = [];
  if (samples.length === 0) unknowns.push("No sample_payloads were supplied, so runtime compatibility coverage is unknown.");
  const proposedPaths = Object.keys(proposedFields);
  for (const path of proposedPaths) {
    const covered = samples.some((sample) => valueAtPath(sample, path) !== undefined);
    if (!covered) unknowns.push(`No supplied sample covers proposed field ${path}.`);
  }
  return unknowns;
}

function buildProposal({ currentSchema, proposedSchema, policy, migrationNotes, validationResults, allBreaking }) {
  return {
    target: "schema-publisher",
    approval_gate: "requires_human_or_schema_publisher_approval",
    schema_name: stringValue(proposedSchema.name) ?? stringValue(currentSchema.name) ?? "unknown",
    from_version: stringValue(currentSchema.version) ?? "unknown",
    to_version: stringValue(proposedSchema.version) ?? "unknown",
    versioning_rule: policy.versioning_rule,
    proposal_status: "ready_for_review",
    validation_summary: {
      sample_count: validationResults.length,
      valid_proposed_samples: validationResults.filter((result) => result.valid_proposed).length,
      breaking_changes_count: allBreaking.length,
    },
    migration_notes: migrationNotes,
    external_side_effects: "none",
  };
}

function stringValue(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
