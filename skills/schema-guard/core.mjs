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

const SUPPORTED_SCHEMA_KEYWORDS = new Set(["enum", "format", "items", "properties", "required", "type"]);
const SUPPORTED_ROOT_KEYWORDS = new Set([...SUPPORTED_SCHEMA_KEYWORDS, "$id"]);
const SUPPORTED_VERSIONING_RULES = new Set(["semver_minor_for_additive"]);
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot canonicalize non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}/${index}`));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new TypeError(`Cannot canonicalize undefined value at ${path}/${key}`);
      return [key, canonicalize(value[key], `${path}/${key}`)];
    }));
  }
  throw new TypeError(`Cannot canonicalize value at ${path}`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Json(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function pointerSegment(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function assertKnownKeywords(schema, label, root) {
  const allowed = root ? SUPPORTED_ROOT_KEYWORDS : SUPPORTED_SCHEMA_KEYWORDS;
  for (const keyword of Object.keys(schema)) {
    if (!allowed.has(keyword)) throw new TypeError(`${label}.${keyword} is an unsupported keyword`);
  }
}

function assertSchema(schema, label, { root = false } = {}) {
  if (!isPlainObject(schema)) throw new TypeError(`${label} must be a schema object`);
  assertKnownKeywords(schema, label, root);
  if (typeof schema.type !== "string" || !SUPPORTED_TYPES.has(schema.type)) {
    throw new TypeError(`${label} has unsupported schema type`);
  }
  if (root && schema.type !== "object") throw new TypeError(`${label} must be an object schema`);
  if (schema.$id !== undefined && (typeof schema.$id !== "string" || schema.$id.length === 0)) {
    throw new TypeError(`${label}.$id must be a non-empty string`);
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new TypeError(`${label}.enum must be a non-empty array`);
    }
    for (const value of schema.enum) {
      canonicalJson(value);
      if (!typeMatches(schema.type, value)) throw new TypeError(`${label}.enum values must match its type`);
    }
  }
  if (schema.format !== undefined) {
    if (schema.type !== "string" || typeof schema.format !== "string" || !SUPPORTED_FORMATS.has(schema.format)) {
      throw new TypeError(`${label}.format has unsupported format`);
    }
  }
  if (schema.properties !== undefined) {
    if (schema.type !== "object" || !isPlainObject(schema.properties)) {
      throw new TypeError(`${label}.properties is only supported for object schemas`);
    }
    for (const [name, childSchema] of Object.entries(schema.properties)) {
      assertSchema(childSchema, `${label}.properties.${name}`);
    }
  }
  if (schema.required !== undefined) {
    if (schema.type !== "object" || !Array.isArray(schema.required) || schema.required.some((field) => typeof field !== "string")) {
      throw new TypeError(`${label}.required must be an array of strings for an object schema`);
    }
    if (new Set(schema.required).size !== schema.required.length) {
      throw new TypeError(`${label}.required must not contain duplicates`);
    }
    for (const field of schema.required) {
      if (!Object.hasOwn(schema.properties ?? {}, field)) {
        throw new TypeError(`${label}.required field ${field} must name a declared property`);
      }
    }
  }
  if (schema.items !== undefined) {
    if (schema.type !== "array") throw new TypeError(`${label}.items is only supported for array schemas`);
    assertSchema(schema.items, `${label}.items`);
  }
}

function assertObjectSchema(schema, label) {
  assertSchema(schema, label, { root: true });
}

function assertPolicy(policy) {
  if (!isPlainObject(policy)) throw new TypeError("policy must be an object");
  if (typeof policy.breaking_allowed !== "boolean") {
    throw new TypeError("policy.breaking_allowed must be a boolean");
  }
  if (!Array.isArray(policy.required_fields) || policy.required_fields.some((field) => typeof field !== "string")) {
    throw new TypeError("policy.required_fields must be an array of strings");
  }
  if (typeof policy.versioning_rule !== "string" || policy.versioning_rule.length === 0 || !SUPPORTED_VERSIONING_RULES.has(policy.versioning_rule)) {
    throw new TypeError("policy.versioning_rule must be a supported non-empty string");
  }
}

function assertSource(source) {
  if (!isPlainObject(source)) throw new TypeError("source must be an object when emitting a registry event");
  if (typeof source.final_url !== "string") throw new TypeError("source.final_url must be an https URL");
  let url;
  try {
    url = new URL(source.final_url);
  } catch {
    throw new TypeError("source.final_url must be an https URL");
  }
  if (url.protocol !== "https:") throw new TypeError("source.final_url must be an https URL");
  if (typeof source.content_digest !== "string" || !SHA256_DIGEST_PATTERN.test(source.content_digest)) {
    throw new TypeError("source.content_digest must use sha256:<digest>");
  }
  return cloneJson(source);
}

function requiredSet(schema) {
  return new Set(schema.required ?? []);
}

function contract(schema) {
  const result = { type: schema.type };
  if (schema.enum !== undefined) result.enum = cloneJson(schema.enum);
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

function compareConstraints(oldSchema, newSchema, path, changes) {
  if (oldSchema.enum !== undefined && newSchema.enum !== undefined) {
    if (!isSubset(oldSchema.enum, newSchema.enum)) {
      changes.push(change(`${path}/enum`, cloneJson(oldSchema.enum), cloneJson(newSchema.enum), "enum_must_not_narrow"));
    }
  } else if (oldSchema.enum === undefined && newSchema.enum !== undefined) {
    changes.push(change(`${path}/enum`, null, cloneJson(newSchema.enum), "enum_must_not_narrow"));
  }
  if (oldSchema.format !== newSchema.format && newSchema.format !== undefined) {
    changes.push(change(`${path}/format`, oldSchema.format ?? null, newSchema.format, "format_must_not_become_stricter"));
  }
}

function compareSchema(oldSchema, newSchema, path, changes, policy, enforcePolicyRequired = false) {
  if (oldSchema.type !== newSchema.type) {
    changes.push(change(`${path}/type`, oldSchema.type, newSchema.type, "property_type_must_not_change"));
    return;
  }
  compareConstraints(oldSchema, newSchema, path, changes);

  if (oldSchema.type === "object") {
    const oldProperties = oldSchema.properties ?? {};
    const newProperties = newSchema.properties ?? {};
    const oldRequired = requiredSet(oldSchema);
    const newRequired = requiredSet(newSchema);

    for (const name of Object.keys(oldProperties)) {
      if (!Object.hasOwn(newProperties, name)) {
        changes.push(change(
          `${path}/properties/${pointerSegment(name)}`,
          contract(oldProperties[name]),
          null,
          "property_must_not_be_removed",
        ));
      }
    }
    for (const name of newRequired) {
      if (!oldRequired.has(name)) {
        changes.push(change(
          `${path}/required/${pointerSegment(name)}`,
          Object.hasOwn(oldProperties, name) ? "optional" : null,
          "required",
          Object.hasOwn(oldProperties, name)
            ? "optional_property_must_not_become_required"
            : "new_required_property_needs_explicit_transition",
        ));
      }
    }
    if (enforcePolicyRequired) {
      for (const name of policy.required_fields) {
        if (Object.hasOwn(newProperties, name) && !newRequired.has(name)) {
          changes.push(change(
            `${path}/required/${pointerSegment(name)}`,
            oldRequired.has(name) ? "required" : "optional",
            "optional",
            "policy_required_field_must_remain_required",
          ));
        }
      }
    }
    for (const name of Object.keys(oldProperties)) {
      if (Object.hasOwn(newProperties, name)) {
        compareSchema(oldProperties[name], newProperties[name], `${path}/properties/${pointerSegment(name)}`, changes, policy);
      }
    }
  }

  if (oldSchema.type === "array") {
    if (oldSchema.items === undefined && newSchema.items !== undefined) {
      changes.push(change(`${path}/items`, null, contract(newSchema.items), "array_items_must_not_become_more_restrictive"));
    } else if (oldSchema.items !== undefined && newSchema.items !== undefined) {
      compareSchema(oldSchema.items, newSchema.items, `${path}/items`, changes, policy);
    }
  }
}

function compareObjectSchemas(currentSchema, proposedSchema, policy) {
  const changes = [];
  compareSchema(currentSchema, proposedSchema, "", changes, policy, true);
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
  switch (format) {
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "date": {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!match) return false;
      const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
      return date.getUTCFullYear() === Number(match[1])
        && date.getUTCMonth() === Number(match[2]) - 1
        && date.getUTCDate() === Number(match[3]);
    }
    case "date-time": return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
    case "time": return /^\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
    case "uri":
      try { return Boolean(new URL(value)); } catch { return false; }
    case "uuid": return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    case "ipv4": return value.split(".").length === 4 && value.split(".").every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
    case "hostname": return /^(?=.{1,253}\.?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(value);
    default: return false;
  }
}

function orderedPropertyNames(schema) {
  const required = schema.required ?? [];
  const optional = Object.keys(schema.properties ?? {}).filter((name) => !required.includes(name)).sort();
  return [...required, ...optional];
}

function validateValue(schema, value, path, errors) {
  if (!typeMatches(schema.type, value)) {
    errors.push({ path, keyword: "type", expected: schema.type, actual: value === null ? "null" : Array.isArray(value) ? "array" : typeof value });
    return;
  }
  if (schema.enum !== undefined && !hasValue(schema.enum, value)) {
    errors.push({ path, keyword: "enum", expected: cloneJson(schema.enum), actual: value });
  }
  if (schema.format !== undefined && !validFormat(schema.format, value)) {
    errors.push({ path, keyword: "format", expected: schema.format, actual: value });
  }
  if (schema.type === "array" && schema.items !== undefined) {
    value.forEach((item, index) => validateValue(schema.items, item, `${path}/${index}`, errors));
  }
  if (schema.type === "object") {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) {
        errors.push({ path: `${path}/${pointerSegment(name)}`, keyword: "required", expected: "present", actual: "missing" });
      }
    }
    for (const name of orderedPropertyNames(schema)) {
      if (Object.hasOwn(value, name)) {
        validateValue(schema.properties[name], value[name], `${path}/${pointerSegment(name)}`, errors);
      }
    }
  }
}

function validatePayload(schema, payload, index) {
  const errors = [];
  validateValue(schema, payload, "", errors);
  return { index, valid: errors.length === 0, errors };
}

function migrationNotesFor(currentSchema, proposedSchema, breakingChanges) {
  const oldProperties = currentSchema.properties ?? {};
  const newProperties = proposedSchema.properties ?? {};
  const notes = [];
  for (const name of Object.keys(newProperties)) {
    if (!Object.hasOwn(oldProperties, name) && !(proposedSchema.required ?? []).includes(name)) {
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
    source,
    proposed_schema_digest: sha256Json(proposedSchema),
    compatibility_digest: compatibility.verdict_digest,
    validation_summary: {
      sample_count: validationResults.length,
      valid_count: validationResults.filter((result) => result.valid).length,
      invalid_count: validationResults.filter((result) => !result.valid).length,
      sample_coverage_supplied: validationResults.length > 0,
    },
  };
  const stableEvent = cloneJson(event);
  return { ...stableEvent, event_digest: sha256Json(stableEvent) };
}

export function evaluateSchemaChange({ currentSchema, proposedSchema, samplePayloads = [], policy, source }) {
  assertObjectSchema(currentSchema, "current_schema");
  assertObjectSchema(proposedSchema, "proposed_schema");
  if (!Array.isArray(samplePayloads)) throw new TypeError("sample_payloads must be an array");
  assertPolicy(policy);

  const breakingChanges = compareObjectSchemas(currentSchema, proposedSchema, policy);
  const validationResults = samplePayloads.map((payload, index) => validatePayload(proposedSchema, payload, index));
  const samplesValid = validationResults.every((result) => result.valid);
  const compatibilityBase = {
    compatible: (breakingChanges.length === 0 || policy.breaking_allowed) && samplesValid,
    breaking_changes: breakingChanges,
    sample_coverage_supplied: samplePayloads.length > 0,
    sample_coverage: samplePayloads.length > 0 ? "supplied" : "not_supplied",
  };
  const compatibility = {
    ...compatibilityBase,
    verdict_digest: sha256Json({ compatibility: compatibilityBase, validation_results: validationResults }),
  };
  const migrationNotes = migrationNotesFor(currentSchema, proposedSchema, breakingChanges);
  const registryEventResult = compatibility.compatible
    ? registryEvent({ proposedSchema, source: assertSource(source), compatibility, validationResults })
    : null;
  return {
    compatibility,
    validation_results: validationResults,
    migration_notes: migrationNotes,
    registry_event: registryEventResult,
  };
}
