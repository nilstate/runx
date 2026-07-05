import fs from "node:fs";

const inputs = readInputs();
const currentSchema = normalizeSchema(inputs.current_schema, "current_schema");
const proposedSchema = normalizeSchema(inputs.proposed_schema, "proposed_schema");
const samplePayloads = normalizeSamples(inputs.sample_payloads);
const policy = normalizePolicy(inputs.compatibility_policy);

const diff = compareSchemas(currentSchema, proposedSchema, policy);
const validationResults = validateSamples(samplePayloads, proposedSchema);
const validationFailures = validationResults.filter((entry) => !entry.valid);
const hasSamples = samplePayloads.length > 0;
const compatible = diff.breaking_changes.length === 0 && validationFailures.length === 0 && hasSamples;
const refusedReasons = [];

if (diff.breaking_changes.length > 0 && !policy.breaking_allowed) {
  refusedReasons.push("breaking_changes_disallowed");
}
if (validationFailures.length > 0) {
  refusedReasons.push("sample_validation_failed");
}
if (!hasSamples) {
  refusedReasons.push("missing_sample_coverage");
}

const compatibility = {
  decision: compatible ? "proposal_ready" : "refused",
  compatible,
  schema_id: proposedSchema.schema_id,
  current_version: currentSchema.version,
  proposed_version: proposedSchema.version,
  policy: {
    breaking_allowed: policy.breaking_allowed,
    required_fields: policy.required_fields,
    versioning_rule: policy.versioning_rule,
  },
  additive_changes: diff.additive_changes,
  relaxing_changes: diff.relaxing_changes,
  breaking_changes: diff.breaking_changes,
  refused_reasons: refusedReasons,
  side_effects: "none",
};

const result = {
  compatibility,
  validation_results: validationResults,
  migration_notes: migrationNotes({ compatibility, diff, validationResults }),
};

if (compatible) {
  result.publish_schema_proposal = buildProposal({
    currentSchema,
    proposedSchema,
    diff,
    samplePayloads,
    validationResults,
    policy,
  });
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    current_schema: parseInput(process.env.RUNX_INPUT_CURRENT_SCHEMA),
    proposed_schema: parseInput(process.env.RUNX_INPUT_PROPOSED_SCHEMA),
    sample_payloads: parseInput(process.env.RUNX_INPUT_SAMPLE_PAYLOADS),
    compatibility_policy: parseInput(process.env.RUNX_INPUT_COMPATIBILITY_POLICY),
  };
}

function parseInput(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeSchema(value, label) {
  const schema = objectValue(value, label);
  const schemaId = stringValue(schema.schema_id) ?? stringValue(schema.id) ?? label;
  const version = stringValue(schema.version) ?? "unversioned";
  const fieldSource = objectValue(schema.fields ?? schema.properties, `${label}.fields`);
  const jsonSchemaRequired = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const fields = new Map();

  for (const [name, rawField] of Object.entries(fieldSource)) {
    fields.set(name, normalizeField(name, rawField, jsonSchemaRequired.has(name), `${label}.fields.${name}`));
  }

  if (fields.size === 0) {
    throw new Error(`${label}.fields must contain at least one field`);
  }

  return {
    schema_id: schemaId,
    version,
    raw: schema,
    fields,
  };
}

function normalizeField(name, value, requiredByJsonSchema, label) {
  if (typeof value === "string") {
    return { name, type: value, required: requiredByJsonSchema };
  }
  const field = objectValue(value, label);
  return {
    name,
    type: normalizeType(field.type ?? "any"),
    required: booleanValue(field.required) ?? requiredByJsonSchema,
    description: stringValue(field.description) ?? null,
  };
}

function normalizeType(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).sort().join("|");
  }
  return String(value);
}

function normalizeSamples(value) {
  if (!Array.isArray(value)) {
    throw new Error("sample_payloads must be an array");
  }
  return value.map((entry, index) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && ("payload" in entry || "data" in entry)) {
      return {
        id: stringValue(entry.id) ?? `sample-${index + 1}`,
        payload: objectValue(entry.payload ?? entry.data, `sample_payloads[${index}].payload`),
      };
    }
    return {
      id: `sample-${index + 1}`,
      payload: objectValue(entry, `sample_payloads[${index}]`),
    };
  });
}

function normalizePolicy(value) {
  const policy = objectValue(value, "compatibility_policy");
  return {
    breaking_allowed: booleanValue(policy.breaking_allowed) ?? false,
    required_fields: Array.isArray(policy.required_fields) ? policy.required_fields.map(String) : [],
    versioning_rule: stringValue(policy.versioning_rule) ?? "not specified",
  };
}

function compareSchemas(currentSchema, proposedSchema, policy) {
  const additive = [];
  const relaxing = [];
  const breaking = [];

  for (const [name, currentField] of currentSchema.fields) {
    const proposedField = proposedSchema.fields.get(name);
    if (!proposedField) {
      breaking.push(breakingChange({
        code: "field_removed",
        field_path: name,
        old_contract: contractFor(currentField),
        new_contract: null,
        policy_rule: "existing fields may not be removed without explicit breaking approval",
      }));
      continue;
    }

    if (currentField.type !== proposedField.type) {
      breaking.push(breakingChange({
        code: "type_changed",
        field_path: name,
        old_contract: contractFor(currentField),
        new_contract: contractFor(proposedField),
        policy_rule: "field types must remain stable for compatible changes",
      }));
    }

    if (!currentField.required && proposedField.required) {
      breaking.push(breakingChange({
        code: "field_became_required",
        field_path: name,
        old_contract: contractFor(currentField),
        new_contract: contractFor(proposedField),
        policy_rule: "optional fields may not become required without breaking approval",
      }));
    }

    if (currentField.required && !proposedField.required) {
      relaxing.push({
        field_path: name,
        old_contract: contractFor(currentField),
        new_contract: contractFor(proposedField),
        note: "required field relaxed to optional",
      });
    }
  }

  for (const [name, proposedField] of proposedSchema.fields) {
    if (currentSchema.fields.has(name)) continue;
    if (proposedField.required) {
      breaking.push(breakingChange({
        code: "new_required_field",
        field_path: name,
        old_contract: null,
        new_contract: contractFor(proposedField),
        policy_rule: "new required fields break existing payloads",
      }));
    } else {
      additive.push({
        field_path: name,
        new_contract: contractFor(proposedField),
        note: "optional field added",
      });
    }
  }

  for (const requiredField of policy.required_fields) {
    if (proposedSchema.fields.has(requiredField)) continue;
    breaking.push(breakingChange({
      code: "policy_required_field_missing",
      field_path: requiredField,
      old_contract: currentSchema.fields.has(requiredField) ? contractFor(currentSchema.fields.get(requiredField)) : null,
      new_contract: null,
      policy_rule: "compatibility_policy.required_fields must be present in proposed_schema",
    }));
  }

  return {
    additive_changes: additive,
    relaxing_changes: relaxing,
    breaking_changes: policy.breaking_allowed ? [] : breaking,
    breaking_changes_allowed: policy.breaking_allowed ? breaking : [],
  };
}

function validateSamples(samples, schema) {
  return samples.map((sample) => {
    const errors = [];
    for (const field of schema.fields.values()) {
      const exists = Object.prototype.hasOwnProperty.call(sample.payload, field.name);
      if (!exists) {
        if (field.required) {
          errors.push({
            field_path: field.name,
            code: "missing_required_field",
            expected: field.type,
          });
        }
        continue;
      }
      if (!matchesType(sample.payload[field.name], field.type)) {
        errors.push({
          field_path: field.name,
          code: "type_mismatch",
          expected: field.type,
          actual: actualType(sample.payload[field.name]),
        });
      }
    }
    return {
      sample_id: sample.id,
      valid: errors.length === 0,
      errors,
    };
  });
}

function matchesType(value, type) {
  if (type === "any") return true;
  const accepted = type.split("|");
  return accepted.some((entry) => {
    if (entry === "array") return Array.isArray(value);
    if (entry === "integer") return Number.isInteger(value);
    if (entry === "number") return typeof value === "number" && Number.isFinite(value);
    if (entry === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (entry === "null") return value === null;
    return typeof value === entry;
  });
}

function actualType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function buildProposal({ currentSchema, proposedSchema, diff, samplePayloads, validationResults, policy }) {
  return {
    proposal_id: `schema-guard:${proposedSchema.schema_id}:${currentSchema.version}->${proposedSchema.version}`,
    status: "ready_for_review",
    live_write_attempted: false,
    schema_id: proposedSchema.schema_id,
    current_version: currentSchema.version,
    proposed_version: proposedSchema.version,
    proposed_schema: proposedSchema.raw,
    change_summary: {
      additive_changes: diff.additive_changes,
      relaxing_changes: diff.relaxing_changes,
      breaking_changes: [],
    },
    sample_coverage: samplePayloads.map((sample) => sample.id),
    validation_results: validationResults,
    policy_evidence: {
      breaking_allowed: policy.breaking_allowed,
      required_fields: policy.required_fields,
      versioning_rule: policy.versioning_rule,
    },
    next_step: "review_and_publish_with_runx_registry_publish",
  };
}

function migrationNotes({ compatibility, diff, validationResults }) {
  const notes = [
    {
      code: "side_effects",
      message: "No live schema write or remote publish was attempted.",
    },
  ];

  for (const change of diff.additive_changes) {
    notes.push({
      code: "additive_field",
      field_path: change.field_path,
      message: "Optional additive field is compatible with existing payloads.",
    });
  }

  for (const change of diff.relaxing_changes) {
    notes.push({
      code: "relaxed_field",
      field_path: change.field_path,
      message: "Relaxing a required field to optional is compatible for existing payload producers.",
    });
  }

  for (const change of compatibility.breaking_changes) {
    notes.push({
      code: "refused_breaking_change",
      field_path: change.field_path,
      message: `${change.code}: ${change.policy_rule}`,
    });
  }

  for (const sample of validationResults.filter((entry) => !entry.valid)) {
    notes.push({
      code: "sample_validation_failed",
      sample_id: sample.sample_id,
      message: "The proposed schema does not validate a supplied sample payload.",
    });
  }

  if (compatibility.refused_reasons.includes("missing_sample_coverage")) {
    notes.push({
      code: "missing_sample_coverage",
      message: "No sample payloads were supplied, so the skill refused to invent coverage.",
    });
  }

  return notes;
}

function breakingChange({ code, field_path, old_contract, new_contract, policy_rule }) {
  return {
    code,
    field_path,
    old_contract,
    new_contract,
    policy_rule,
  };
}

function contractFor(field) {
  return {
    type: field.type,
    required: field.required,
  };
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function stringValue(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  return null;
}
