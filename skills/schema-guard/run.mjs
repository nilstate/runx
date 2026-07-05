import fs from "node:fs";
import crypto from "node:crypto";

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  const parsed = JSON.parse(raw);
  return {
    current_schema: parseMaybeJson(parsed.current_schema),
    proposed_schema: parseMaybeJson(parsed.proposed_schema),
    sample_payloads: parseMaybeJson(parsed.sample_payloads),
    compatibility_policy: parseMaybeJson(parsed.compatibility_policy),
  };
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{"]/.test(trimmed)) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSchema(schema, basePath = "$", inheritedRequired = []) {
  if (!schema || typeof schema !== "object") {
    return new Map();
  }
  const fields = new Map();
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(asArray(schema.required));

  for (const [name, child] of Object.entries(properties)) {
    const path = basePath === "$" ? `$.${name}` : `${basePath}.${name}`;
    const childRequired = required.has(name) || inheritedRequired.includes(path);
    fields.set(path, contractFor(child, childRequired));
    if (child && typeof child === "object" && child.type === "object") {
      for (const [nestedPath, nestedContract] of normalizeSchema(child, path).entries()) {
        fields.set(nestedPath, nestedContract);
      }
    }
  }
  return fields;
}

function contractFor(node, required) {
  const schema = node && typeof node === "object" ? node : {};
  return {
    type: Array.isArray(schema.type) ? schema.type.join("|") : schema.type || "any",
    required,
    enum: Array.isArray(schema.enum) ? [...schema.enum] : null,
    additionalProperties: schema.additionalProperties,
  };
}

function describeContract(contract) {
  if (!contract) {
    return "absent";
  }
  const parts = [`type=${contract.type}`, `required=${contract.required}`];
  if (contract.enum) {
    parts.push(`enum=[${contract.enum.map(String).join(",")}]`);
  }
  if (contract.additionalProperties !== undefined) {
    parts.push(`additionalProperties=${contract.additionalProperties}`);
  }
  return parts.join("; ");
}

function compareSchemas(currentSchema, proposedSchema, policy) {
  const current = normalizeSchema(currentSchema);
  const proposed = normalizeSchema(proposedSchema);
  const breaking = [];
  const notes = [];
  const paths = new Set([...current.keys(), ...proposed.keys()]);

  for (const path of [...paths].sort()) {
    const oldContract = current.get(path);
    const newContract = proposed.get(path);
    if (oldContract && !newContract) {
      breaking.push(change(path, oldContract, newContract, "field_removed"));
      continue;
    }
    if (!oldContract && newContract) {
      notes.push({
        path,
        kind: newContract.required ? "new_required_field" : "new_optional_field",
        note: newContract.required
          ? "New required field can break existing callers."
          : "Additive optional field.",
      });
      if (newContract.required) {
        breaking.push(change(path, oldContract, newContract, "new_required_field"));
      }
      continue;
    }
    if (!oldContract || !newContract) {
      continue;
    }
    if (oldContract.type !== newContract.type) {
      breaking.push(change(path, oldContract, newContract, "type_changed"));
    }
    if (!oldContract.required && newContract.required) {
      breaking.push(change(path, oldContract, newContract, "field_became_required"));
    }
    if (enumNarrowed(oldContract.enum, newContract.enum)) {
      breaking.push(change(path, oldContract, newContract, "enum_narrowed"));
    } else if (enumExpanded(oldContract.enum, newContract.enum)) {
      notes.push({ path, kind: "enum_expanded", note: "Enum was expanded without removing existing values." });
    }
  }

  for (const requiredPath of asArray(policy.required_fields).map(normalizePolicyPath)) {
    if (!proposed.has(requiredPath)) {
      breaking.push({
        path: requiredPath,
        old_contract: describeContract(current.get(requiredPath)),
        new_contract: "absent",
        policy_rule: "policy_required_field_missing",
      });
    }
  }

  return { current, proposed, breaking, notes };
}

function normalizePolicyPath(path) {
  const value = String(path || "").trim();
  if (!value) {
    return "$";
  }
  return value.startsWith("$.") ? value : `$.${value.replace(/^\./, "")}`;
}

function change(path, oldContract, newContract, policyRule) {
  return {
    path,
    old_contract: describeContract(oldContract),
    new_contract: describeContract(newContract),
    policy_rule: policyRule,
  };
}

function enumNarrowed(oldEnum, newEnum) {
  if (!oldEnum || !newEnum) {
    return false;
  }
  return oldEnum.some((value) => !newEnum.includes(value));
}

function enumExpanded(oldEnum, newEnum) {
  if (!oldEnum || !newEnum) {
    return false;
  }
  return newEnum.some((value) => !oldEnum.includes(value)) && oldEnum.every((value) => newEnum.includes(value));
}

function typeOfValue(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (Number.isInteger(value)) {
    return "integer";
  }
  return typeof value;
}

function validateSample(sample, schema, pointer = "$") {
  const errors = [];
  const expectedType = schema?.type;
  if (expectedType) {
    const expected = Array.isArray(expectedType) ? expectedType : [expectedType];
    const actual = typeOfValue(sample);
    if (!expected.includes(actual)) {
      return [`${pointer} expected ${expected.join("|")}, got ${actual}`];
    }
  }

  if (Array.isArray(schema?.enum) && !schema.enum.includes(sample)) {
    errors.push(`${pointer} expected one of ${schema.enum.map(String).join(", ")}`);
  }

  if (schema?.type === "object") {
    const properties = schema.properties || {};
    for (const field of asArray(schema.required)) {
      if (!sample || typeof sample !== "object" || !(field in sample)) {
        errors.push(`${pointer}.${field} is required`);
      }
    }
    if (sample && typeof sample === "object" && !Array.isArray(sample)) {
      for (const [field, value] of Object.entries(sample)) {
        if (properties[field]) {
          errors.push(...validateSample(value, properties[field], `${pointer}.${field}`));
        } else if (schema.additionalProperties === false) {
          errors.push(`${pointer}.${field} is not allowed`);
        }
      }
    }
  }
  return errors;
}

function coveredPaths(sample, basePath = "$") {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
    return new Set();
  }
  const paths = new Set();
  for (const [field, value] of Object.entries(sample)) {
    const path = `${basePath}.${field}`;
    paths.add(path);
    for (const nested of coveredPaths(value, path)) {
      paths.add(nested);
    }
  }
  return paths;
}

function buildCoverageNotes(samplePayloads, proposedFields) {
  const covered = new Set();
  for (const sample of samplePayloads) {
    for (const path of coveredPaths(sample)) {
      covered.add(path);
    }
  }
  return [...proposedFields.keys()].sort().map((path) => ({
    path,
    kind: covered.has(path) ? "sample_covered" : "sample_not_covered",
    note: covered.has(path)
      ? "At least one supplied sample includes this path."
      : "No supplied sample covers this path; coverage was not invented.",
  }));
}

function main() {
  const { current_schema, proposed_schema, sample_payloads, compatibility_policy } = readInputs();
  if (!Array.isArray(sample_payloads)) {
    throw new Error("sample_payloads must be an array");
  }
  const policy = compatibility_policy && typeof compatibility_policy === "object" ? compatibility_policy : {};
  const { proposed, breaking, notes } = compareSchemas(current_schema, proposed_schema, policy);
  const validation_results = sample_payloads.map((sample, index) => {
    const errors = validateSample(sample, proposed_schema);
    return {
      sample_index: index,
      valid: errors.length === 0,
      errors,
      sample_digest: sha256(sample),
    };
  });
  const coverageNotes = buildCoverageNotes(sample_payloads, proposed);
  const samplesValid = validation_results.every((result) => result.valid);
  const policyAllows = Boolean(policy.breaking_allowed) || breaking.length === 0;
  const compatible = policyAllows && samplesValid;
  const compatibility = {
    status: compatible ? "compatible" : "refused",
    compatible,
    policy_result: policyAllows ? "allowed" : "blocked_by_policy",
    versioning_rule: policy.versioning_rule || "unspecified",
    breaking_allowed: Boolean(policy.breaking_allowed),
    breaking_changes: breaking,
  };
  const migration_notes = [
    ...notes,
    ...coverageNotes,
    ...(samplesValid ? [] : [{ kind: "sample_validation_failed", note: "One or more samples failed proposed schema validation." }]),
  ];
  const output = {
    compatibility,
    validation_results,
    migration_notes,
  };
  if (compatible) {
    output.publish_schema_proposal = {
      status: "proposed",
      gate: "schema-publisher-or-human-approver",
      live_write_performed: false,
      current_schema_digest: sha256(current_schema),
      proposed_schema_digest: sha256(proposed_schema),
      changed_paths: [...new Set([...notes.map((note) => note.path).filter(Boolean)])].sort(),
    };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({
    compatibility: {
      status: "refused",
      compatible: false,
      policy_result: "invalid_input",
      breaking_changes: [{ path: "$", old_contract: "unknown", new_contract: "unknown", policy_rule: message }],
    },
    validation_results: [],
    migration_notes: [{ kind: "invalid_input", note: message }],
  })}\n`);
}
