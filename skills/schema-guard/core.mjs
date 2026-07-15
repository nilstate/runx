import { createHash } from "node:crypto";

const SUPPORTED_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

const SUPPORTED_FORMATS = new Set([
  "date",
  "date-time",
  "email",
  "hostname",
  "ipv4",
  "time",
  "uri",
  "uuid",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number at ${path}`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}/${index}`));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          if (value[key] === undefined) {
            throw new TypeError(`Cannot canonicalize undefined value at ${path}/${key}`);
          }
          return [key, canonicalize(value[key], `${path}/${key}`)];
        }),
    );
  }
  throw new TypeError(`Cannot canonicalize value at ${path}`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Json(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function pointerSegment(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function assertObjectSchema(schema, label) {
  if (!isPlainObject(schema) || schema.type !== "object") {
    throw new TypeError(`${label} must be an object schema`);
  }
  if (schema.properties !== undefined && !isPlainObject(schema.properties)) {
    throw new TypeError(`${label}.properties must be an object`);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((field) => typeof field !== "string"))) {
    throw new TypeError(`${label}.required must be an array of strings`);
  }
  for (const [name, propertySchema] of Object.entries(schema.properties ?? {})) {
    assertPropertySchema(propertySchema, `${label}.properties.${name}`);
  }
}

function assertPropertySchema(schema, label) {
  if (!isPlainObject(schema) || typeof schema.type !== "string" || !SUPPORTED_TYPES.has(schema.type)) {
    throw new TypeError(`${label} has unsupported schema type`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new TypeError(`${label}.enum must be a non-empty array`);
  }
  if (schema.format !== undefined && (typeof schema.format !== "string" || !SUPPORTED_FORMATS.has(schema.format))) {
    throw new TypeError(`${label}.format has unsupported format`);
  }
  if (schema.type === "array" && schema.items !== undefined) {
    assertPropertySchema(schema.items, `${label}.items`);
  }
  if (schema.type === "object" && schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      throw new TypeError(`${label}.properties must be an object`);
    }
    for (const [name, childSchema] of Object.entries(schema.properties)) {
      assertPropertySchema(childSchema, `${label}.properties.${name}`);
    }
  }
}

function requiredSet(schema) {
  return new Set(schema.required ?? []);
}

function contract(schema) {
  const result = { type: schema.type };
  if (schema.enum !== undefined) result.enum = schema.enum;
  if (schema.format !== undefined) result.format = schema.format;
  return result;
}

function hasValue(values, candidate) {
  const candidateJson = canonicalJson(candidate);
  return values.some((value) => canonicalJson(value) === candidateJson);
}

function isSubset(subset, superset) {
  return subset.every((value) => hasValue(superset, value));
}

function change(path, oldContract, newContract, policyRule) {
  return { path, old_contract: oldContract, new_contract: newContract, policy_rule: policyRule };
}

function comparePropertySchemas(name, oldSchema, newSchema, changes) {
  const basePath = `/properties/${pointerSegment(name)}`;
  if (oldSchema.type !== newSchema.type) {
    changes.push(change(`${basePath}/type`, oldSchema.type, newSchema.type, "property_type_must_not_change"));
    return;
  }

  if (oldSchema.enum !== undefined && newSchema.enum !== undefined) {
    if (isSubset(newSchema.enum, oldSchema.enum) && !isSubset(oldSchema.enum, newSchema.enum)) {
      changes.push(change(`${basePath}/enum`, oldSchema.enum, newSchema.enum, "enum_must_not_narrow"));
    } else if (!isSubset(newSchema.enum, oldSchema.enum) && !isSubset(oldSchema.enum, newSchema.enum)) {
      changes.push(change(`${basePath}/enum`, oldSchema.enum, newSchema.enum, "enum_must_not_narrow"));
    }
  } else if (oldSchema.enum === undefined && newSchema.enum !== undefined) {
    changes.push(change(`${basePath}/enum`, null, newSchema.enum, "enum_must_not_narrow"));
  }

  if (oldSchema.format !== newSchema.format) {
    if (oldSchema.format === undefined && newSchema.format !== undefined) {
      changes.push(change(`${basePath}/format`, null, newSchema.format, "format_must_not_become_stricter"));
    } else if (oldSchema.format !== undefined && newSchema.format !== undefined) {
      changes.push(change(`${basePath}/format`, oldSchema.format, newSchema.format, "format_must_not_become_stricter"));
    }
  }
}

function compareObjectSchemas(currentSchema, proposedSchema, policy) {
  const currentProperties = currentSchema.properties ?? {};
  const proposedProperties = proposedSchema.properties ?? {};
  const currentRequired = requiredSet(currentSchema);
  const proposedRequired = requiredSet(proposedSchema);
  const changes = [];

  for (const name of Object.keys(currentProperties)) {
    if (!(name in proposedProperties)) {
      changes.push(change(
        `/properties/${pointerSegment(name)}`,
        contract(currentProperties[name]),
        null,
        "property_must_not_be_removed",
      ));
    }
  }

  for (const name of proposedRequired) {
    if (!currentRequired.has(name)) {
      changes.push(change(
        `/required/${pointerSegment(name)}`,
        name in currentProperties ? "optional" : null,
        "required",
        name in currentProperties
          ? "optional_property_must_not_become_required"
          : "new_required_property_needs_explicit_transition",
      ));
    }
  }

  for (const name of policy.required_fields ?? []) {
    if (name in proposedProperties && !proposedRequired.has(name)) {
      changes.push(change(
        `/required/${pointerSegment(name)}`,
        currentRequired.has(name) ? "required" : "optional",
        "optional",
        "policy_required_field_must_remain_required",
      ));
    }
  }

  for (const name of Object.keys(currentProperties)) {
    if (name in proposedProperties) {
      comparePropertySchemas(name, currentProperties[name], proposedProperties[name], changes);
    }
  }
  return changes;
}

function typeMatches(type, value) {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "array": return Array.isArray(value);
    case "object": return isPlainObject(value);
    default: return false;
  }
}

function validFormat(format, value) {
  if (typeof value !== "string") return true;
  switch (format) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "date":
      {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (!match) return false;
        const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
        return date.getUTCFullYear() === Number(match[1])
          && date.getUTCMonth() === Number(match[2]) - 1
          && date.getUTCDate() === Number(match[3]);
      }
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
    case "time":
      return /^\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
    case "uri":
      try { return Boolean(new URL(value)); } catch { return false; }
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    case "ipv4":
      return value.split(".").length === 4 && value.split(".").every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
    case "hostname":
      return /^(?=.{1,253}\.?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(value);
    default:
      return false;
  }
}

function validateValue(schema, value, path, errors) {
  if (!typeMatches(schema.type, value)) {
    errors.push({ path, keyword: "type", expected: schema.type, actual: value === null ? "null" : Array.isArray(value) ? "array" : typeof value });
    return;
  }
  if (schema.enum !== undefined && !hasValue(schema.enum, value)) {
    errors.push({ path, keyword: "enum", expected: schema.enum, actual: value });
  }
  if (schema.format !== undefined && !validFormat(schema.format, value)) {
    errors.push({ path, keyword: "format", expected: schema.format, actual: value });
  }
  if (schema.type === "array" && schema.items !== undefined) {
    value.forEach((item, index) => validateValue(schema.items, item, `${path}/${index}`, errors));
  }
  if (schema.type === "object" && schema.properties !== undefined) {
    const nestedRequired = new Set(schema.required ?? []);
    for (const name of nestedRequired) {
      if (!Object.hasOwn(value, name)) {
        errors.push({ path: `${path}/${pointerSegment(name)}`, keyword: "required", expected: "present", actual: "missing" });
      }
    }
    for (const name of Object.keys(schema.properties)) {
      if (Object.hasOwn(value, name)) {
        validateValue(schema.properties[name], value[name], `${path}/${pointerSegment(name)}`, errors);
      }
    }
  }
}

function orderedPropertyNames(schema) {
  const required = schema.required ?? [];
  const optional = Object.keys(schema.properties ?? {}).filter((name) => !required.includes(name)).sort();
  return [...required.filter((name) => name in (schema.properties ?? {})), ...optional];
}

function validatePayload(schema, payload, index) {
  const errors = [];
  if (!isPlainObject(payload)) {
    errors.push({ path: "", keyword: "type", expected: "object", actual: Array.isArray(payload) ? "array" : typeof payload });
  } else {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(payload, name)) {
        errors.push({ path: `/${pointerSegment(name)}`, keyword: "required", expected: "present", actual: "missing" });
      }
    }
    for (const name of orderedPropertyNames(schema)) {
      if (Object.hasOwn(payload, name)) {
        validateValue(schema.properties?.[name], payload[name], `/${pointerSegment(name)}`, errors);
      }
    }
  }
  return { index, valid: errors.length === 0, errors };
}

function migrationNotesFor(currentSchema, proposedSchema, breakingChanges) {
  const oldProperties = currentSchema.properties ?? {};
  const newProperties = proposedSchema.properties ?? {};
  const notes = [];
  for (const name of Object.keys(newProperties)) {
    if (!(name in oldProperties) && !(proposedSchema.required ?? []).includes(name)) {
      notes.push(`Added optional property /properties/${pointerSegment(name)}.`);
    }
  }
  for (const item of breakingChanges) {
    if (item.policy_rule === "property_must_not_be_removed") {
      notes.push(`Removed property ${item.path}; consumers need a migration before removal.`);
    } else if (item.policy_rule.includes("required")) {
      notes.push(`Requiredness changed at ${item.path}; consumers must supply the new contract.`);
    } else if (item.policy_rule === "property_type_must_not_change") {
      notes.push(`Type changed at ${item.path}; migrate producers and consumers together.`);
    } else if (item.policy_rule === "enum_must_not_narrow") {
      notes.push(`Enum changed at ${item.path}; preserve all previously accepted values.`);
    } else if (item.policy_rule === "format_must_not_become_stricter") {
      notes.push(`Format changed at ${item.path}; validate existing values before rollout.`);
    }
  }
  return notes;
}

function registryEvent({ proposedSchema, source, compatibility, validationResults }) {
  const event = {
    type: "schema.version.recorded",
    schema_id: proposedSchema.$id ?? null,
    source: source ?? {},
    proposed_schema_digest: sha256Json(proposedSchema),
    compatibility_digest: compatibility.verdict_digest,
    validation_summary: {
      sample_count: validationResults.length,
      valid_count: validationResults.filter((result) => result.valid).length,
      invalid_count: validationResults.filter((result) => !result.valid).length,
      sample_coverage_supplied: validationResults.length > 0,
    },
  };
  return { ...event, event_digest: sha256Json(event) };
}

export function evaluateSchemaChange({ currentSchema, proposedSchema, samplePayloads = [], policy, source }) {
  assertObjectSchema(currentSchema, "current_schema");
  assertObjectSchema(proposedSchema, "proposed_schema");
  if (!Array.isArray(samplePayloads)) {
    throw new TypeError("sample_payloads must be an array");
  }
  if (!isPlainObject(policy)) {
    throw new TypeError("policy must be an object");
  }
  if (policy.required_fields !== undefined && (!Array.isArray(policy.required_fields) || policy.required_fields.some((field) => typeof field !== "string"))) {
    throw new TypeError("policy.required_fields must be an array of strings");
  }

  const breakingChanges = compareObjectSchemas(currentSchema, proposedSchema, policy);
  const validationResults = samplePayloads.map((payload, index) => validatePayload(proposedSchema, payload, index));
  const samplesValid = validationResults.every((result) => result.valid);
  const structurallyAllowed = breakingChanges.length === 0 || policy.breaking_allowed === true;
  const compatibilityBase = {
    compatible: structurallyAllowed && samplesValid,
    breaking_changes: breakingChanges,
    sample_coverage_supplied: samplePayloads.length > 0,
    sample_coverage: samplePayloads.length > 0 ? "supplied" : "not_supplied",
  };
  const compatibility = {
    ...compatibilityBase,
    verdict_digest: sha256Json({ compatibility: compatibilityBase, validation_results: validationResults }),
  };
  const migrationNotes = migrationNotesFor(currentSchema, proposedSchema, breakingChanges);
  return {
    compatibility,
    validation_results: validationResults,
    migration_notes: migrationNotes,
    registry_event: compatibility.compatible ? registryEvent({ proposedSchema, source, compatibility, validationResults }) : null,
  };
}
