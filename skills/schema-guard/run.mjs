// schema-guard: report breaking changes between two JSON schemas, validate
// sample payloads against both, and emit a gated publish proposal only when
// the change is compatible under the caller's policy. Read-only: no network,
// no live schema writes. Exit 0 seals a compatible run; exit 65 refuses a
// breaking or blocked change; exit 64 refuses malformed input.

const EXIT_USAGE = 64;
const EXIT_REFUSED = 65;

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function readJsonInput(name, { required = true } = {}) {
  const raw = process.env[`RUNX_INPUT_${name.toUpperCase()}`];
  if (raw === undefined || raw.trim() === "") {
    if (required) fail(EXIT_USAGE, `${name} is required`);
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(EXIT_USAGE, `${name} is not valid JSON`);
  }
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// --- Schema walking -------------------------------------------------------
// Supports the deterministic core of JSON Schema: type, properties, required,
// items, enum, format, additionalProperties. Anything else is carried through
// untouched and compared structurally.

function schemaAt(schema, segment) {
  if (!isObject(schema)) return undefined;
  if (isObject(schema.properties) && segment in schema.properties) {
    return schema.properties[segment];
  }
  return undefined;
}

function contractOf(schema) {
  if (!isObject(schema)) return String(schema);
  const parts = [];
  if (schema.type) parts.push(`type=${JSON.stringify(schema.type)}`);
  if (schema.enum) parts.push(`enum=${JSON.stringify(schema.enum)}`);
  if (schema.format) parts.push(`format=${schema.format}`);
  if (schema.additionalProperties === false) parts.push("additionalProperties=false");
  return parts.length ? parts.join(" ") : "unconstrained";
}

function requiredSet(schema) {
  return new Set(Array.isArray(schema?.required) ? schema.required : []);
}

function diffSchemas(current, proposed, policy) {
  const breaking = [];
  const additive = [];
  const notes = [];
  const policyRequired = new Set(
    Array.isArray(policy.required_fields) ? policy.required_fields : []
  );

  function walk(cur, prop, path) {
    const curProps = isObject(cur?.properties) ? cur.properties : {};
    const propProps = isObject(prop?.properties) ? prop.properties : {};
    const curReq = requiredSet(cur);
    const propReq = requiredSet(prop);

    for (const key of Object.keys(curProps)) {
      const fieldPath = path ? `${path}.${key}` : key;
      const c = curProps[key];
      const p = propProps[key];

      if (p === undefined) {
        breaking.push({
          field_path: fieldPath,
          old_contract: contractOf(c),
          new_contract: "absent",
          policy_rule: policyRequired.has(fieldPath)
            ? "required_fields: field is policy-protected and was removed"
            : "field removed from schema",
        });
        continue;
      }

      const cType = JSON.stringify(c?.type ?? null);
      const pType = JSON.stringify(p?.type ?? null);
      if (cType !== pType) {
        breaking.push({
          field_path: fieldPath,
          old_contract: contractOf(c),
          new_contract: contractOf(p),
          policy_rule: "field type changed",
        });
      }

      if (Array.isArray(c?.enum) && Array.isArray(p?.enum)) {
        const removedValues = c.enum.filter((v) => !p.enum.includes(v));
        if (removedValues.length > 0) {
          breaking.push({
            field_path: fieldPath,
            old_contract: contractOf(c),
            new_contract: contractOf(p),
            policy_rule: `enum narrowed: removed ${JSON.stringify(removedValues)}`,
          });
        } else if (p.enum.length > c.enum.length) {
          notes.push(`${fieldPath}: enum widened (non-breaking for readers, check writers)`);
        }
      }

      if (!curReq.has(key) && propReq.has(key)) {
        breaking.push({
          field_path: fieldPath,
          old_contract: "optional",
          new_contract: "required",
          policy_rule: "optional field became required",
        });
      }
      if (curReq.has(key) && !propReq.has(key)) {
        if (policyRequired.has(fieldPath)) {
          breaking.push({
            field_path: fieldPath,
            old_contract: "required",
            new_contract: "optional",
            policy_rule: "required_fields: policy-protected field was relaxed to optional",
          });
        } else {
          notes.push(`${fieldPath}: required relaxed to optional (non-breaking for writers, check readers)`);
        }
      }

      if (isObject(c) && isObject(p)) {
        if (isObject(c.properties) || isObject(p.properties)) {
          walk(c, p, fieldPath);
        }
        if (isObject(c.items) || isObject(p.items)) {
          walk(
            { properties: { "[]": c.items ?? {} } },
            { properties: { "[]": p.items ?? {} } },
            fieldPath
          );
        }
      }
    }

    for (const key of Object.keys(propProps)) {
      if (key in curProps) continue;
      const fieldPath = path ? `${path}.${key}` : key;
      if (propReq.has(key)) {
        breaking.push({
          field_path: fieldPath,
          old_contract: "absent",
          new_contract: `required ${contractOf(propProps[key])}`,
          policy_rule: "new field added as required: existing writers will fail validation",
        });
      } else {
        additive.push({ field_path: fieldPath, new_contract: contractOf(propProps[key]) });
      }
    }

    if (cur?.additionalProperties !== false && prop?.additionalProperties === false) {
      breaking.push({
        field_path: path || "(root)",
        old_contract: "additionalProperties allowed",
        new_contract: "additionalProperties=false",
        policy_rule: "schema closed to additional properties: existing extended payloads will fail",
      });
    }

    for (const fieldPath of policyRequired) {
      if (path === "" && !fieldPath.includes(".")) {
        if (!(fieldPath in propProps) && fieldPath in curProps) continue; // already reported as removed
        if (!(fieldPath in propProps) && !(fieldPath in curProps)) {
          notes.push(`policy required_fields lists "${fieldPath}" but neither schema defines it`);
        }
      }
    }
  }

  walk(current, proposed, "");
  return { breaking, additive, notes };
}

// --- Sample validation ----------------------------------------------------

function validateAgainst(schema, value, path, errors) {
  if (!isObject(schema)) return;
  const t = schema.type;
  const typeOk = (want, v) => {
    switch (want) {
      case "object": return isObject(v);
      case "array": return Array.isArray(v);
      case "string": return typeof v === "string";
      case "number": return typeof v === "number";
      case "integer": return Number.isInteger(v);
      case "boolean": return typeof v === "boolean";
      case "null": return v === null;
      default: return true;
    }
  };
  if (t !== undefined) {
    const wants = Array.isArray(t) ? t : [t];
    if (!wants.some((w) => typeOk(w, value))) {
      errors.push(`${path || "(root)"}: expected type ${JSON.stringify(t)}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    errors.push(`${path || "(root)"}: value not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (isObject(value)) {
    for (const req of requiredSet(schema)) {
      if (!(req in value)) errors.push(`${path || "(root)"}: missing required field "${req}"`);
    }
    if (isObject(schema.properties)) {
      for (const [k, v] of Object.entries(value)) {
        if (k in schema.properties) {
          validateAgainst(schema.properties[k], v, path ? `${path}.${k}` : k, errors);
        } else if (schema.additionalProperties === false) {
          errors.push(`${path || "(root)"}: unexpected field "${k}" (additionalProperties=false)`);
        }
      }
    }
  }
  if (Array.isArray(value) && isObject(schema.items)) {
    value.forEach((item, i) => validateAgainst(schema.items, item, `${path}[${i}]`, errors));
  }
}

function coveredPaths(schema, value, out, path) {
  if (!isObject(schema) || !isObject(schema.properties) || !isObject(value)) return;
  for (const [k, sub] of Object.entries(schema.properties)) {
    const fieldPath = path ? `${path}.${k}` : k;
    if (k in value) {
      out.add(fieldPath);
      coveredPaths(sub, value[k], out, fieldPath);
    }
  }
}

function allPaths(schema, out, path) {
  if (!isObject(schema) || !isObject(schema.properties)) return;
  for (const [k, sub] of Object.entries(schema.properties)) {
    const fieldPath = path ? `${path}.${k}` : k;
    out.add(fieldPath);
    allPaths(sub, out, fieldPath);
  }
}

// --- Versioning -----------------------------------------------------------

function proposeVersionBump(rule, hasBreaking, hasAdditive) {
  switch (rule) {
    case "semver":
    case "major-on-breaking":
      if (hasBreaking) return "major";
      return hasAdditive ? "minor" : "patch";
    case "minor-on-additive":
      return hasAdditive || hasBreaking ? "minor" : "patch";
    default:
      return hasBreaking ? "major" : hasAdditive ? "minor" : "patch";
  }
}

// --- Main -----------------------------------------------------------------

const currentSchema = readJsonInput("current_schema");
const proposedSchema = readJsonInput("proposed_schema");
const samplePayloads = readJsonInput("sample_payloads");
const policy = readJsonInput("compatibility_policy");

if (!isObject(currentSchema)) fail(EXIT_USAGE, "current_schema must be a JSON object");
if (!isObject(proposedSchema)) fail(EXIT_USAGE, "proposed_schema must be a JSON object");
if (!Array.isArray(samplePayloads)) fail(EXIT_USAGE, "sample_payloads must be a JSON array");
if (!isObject(policy)) fail(EXIT_USAGE, "compatibility_policy must be a JSON object");
if (typeof policy.breaking_allowed !== "boolean") {
  fail(EXIT_USAGE, "compatibility_policy.breaking_allowed must be a boolean");
}

const { breaking, additive, notes } = diffSchemas(currentSchema, proposedSchema, policy);

const validationResults = samplePayloads.map((payload, index) => {
  const currentErrors = [];
  const proposedErrors = [];
  validateAgainst(currentSchema, payload, "", currentErrors);
  validateAgainst(proposedSchema, payload, "", proposedErrors);
  return {
    payload_index: index,
    valid_against_current: currentErrors.length === 0,
    valid_against_proposed: proposedErrors.length === 0,
    current_errors: currentErrors,
    proposed_errors: proposedErrors,
  };
});

// Coverage is reported, never invented: fields no sample exercises are named.
const proposedFieldPaths = new Set();
allPaths(proposedSchema, proposedFieldPaths, "");
const exercised = new Set();
for (const payload of samplePayloads) coveredPaths(proposedSchema, payload, exercised, "");
const uncovered = [...proposedFieldPaths].filter((p) => !exercised.has(p)).sort();

const migrationNotes = [...notes];
for (const b of breaking) {
  migrationNotes.push(
    `BREAKING ${b.field_path}: ${b.old_contract} -> ${b.new_contract} (${b.policy_rule})`
  );
}
for (const a of additive) {
  migrationNotes.push(`additive ${a.field_path}: ${a.new_contract}`);
}
if (samplePayloads.length === 0) {
  migrationNotes.push("no sample payloads supplied: validation coverage is empty, not assumed");
} else if (uncovered.length > 0) {
  migrationNotes.push(`sample coverage gap: no sample exercises ${uncovered.join(", ")}`);
}

const samplesBrokenByProposal = validationResults.filter(
  (r) => r.valid_against_current && !r.valid_against_proposed
);

const blockedByPolicy = breaking.length > 0 && policy.breaking_allowed !== true;
const blockedBySamples = samplesBrokenByProposal.length > 0 && policy.breaking_allowed !== true;
const compatible = breaking.length === 0 && samplesBrokenByProposal.length === 0;
const allowed = compatible || policy.breaking_allowed === true;

const compatibility = {
  compatible,
  allowed_under_policy: allowed,
  breaking_changes: breaking,
  additive_changes: additive,
  samples_broken_by_proposal: samplesBrokenByProposal.map((r) => r.payload_index),
  policy: {
    breaking_allowed: policy.breaking_allowed === true,
    required_fields: Array.isArray(policy.required_fields) ? policy.required_fields : [],
    versioning_rule: typeof policy.versioning_rule === "string" ? policy.versioning_rule : "semver",
  },
};

const output = {
  compatibility,
  validation_results: validationResults,
  migration_notes: migrationNotes,
};

if (allowed) {
  output.publish_schema_proposal = {
    kind: "schema_publish_proposal",
    gated: true,
    note: "Proposal only. Consumed by a schema-publisher executor or a human approver; this skill performs no live schema write.",
    proposed_schema: proposedSchema,
    version_bump: proposeVersionBump(compatibility.policy.versioning_rule, breaking.length > 0, additive.length > 0),
    breaking_changes: breaking,
    migration_notes: migrationNotes,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(0);
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.stderr.write(
  `refused: ${breaking.length} breaking change(s), ${samplesBrokenByProposal.length} sample(s) broken, and compatibility_policy.breaking_allowed is false; no publish_schema_proposal emitted\n`
);
process.exit(EXIT_REFUSED);
