import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// schema-guard — catch silent API and data-contract breakage before a migration.
//
// Reads a current schema, a proposed schema, sample payloads, and a compatibility
// policy. Reports breaking changes by field path (old contract, new contract,
// policy rule), validates the samples against the proposed schema, and emits a
// gated publish_schema_proposal ONLY when the change is compatible. It never
// writes a live schema; publishing is the gated schema-publisher executor's job.

const SCHEMA = "schema.guard.result.v1";
const SKILL = "schema-guard";
const VERSION = "0.1.0";
const PUBLISH_EXECUTOR = "schema-publisher";
const MAX_DEPTH = 64;

function main() {
  const inputs = readInputs();
  const skillRoot = process.cwd();

  // Governed refusal: schema-guard only analyzes and PROPOSES. If asked to apply,
  // write, or publish the schema itself, it stops — that effect belongs to the
  // gated schema-publisher executor.
  if (isTruthy(inputs.apply) || isTruthy(inputs.publish) || isTruthy(inputs.write)) {
    throw new Error(
      `refused: schema-guard never writes or publishes a live schema. It only emits a publish_schema_proposal for the gated ${PUBLISH_EXECUTOR} executor. Remove 'apply' and route the proposal to ${PUBLISH_EXECUTOR}.`,
    );
  }

  const current = requireObject(inputs.current_schema, "current_schema");
  const proposed = requireObject(inputs.proposed_schema, "proposed_schema");
  const samples = normalizeSamples(inputs.sample_payloads);
  const policy = normalizePolicy(inputs.compatibility_policy);

  const { breaking, additive } = diffSchemas(current, proposed, policy);
  const validationResults = samples.map((p, i) => {
    const { valid, errors } = validatePayload(p, proposed);
    return { payload_index: i, valid, errors };
  });

  const packet = buildPacket({ current, proposed, breaking, additive, validationResults, policy });
  writeArtifacts(inputs.output_dir, packet, skillRoot);
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// input handling
// ---------------------------------------------------------------------------

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function isTruthy(v) {
  return v === true || v === "true" || v === 1 || v === "1" || v === "yes";
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function asObject(v) {
  return isPlainObject(v) ? v : {};
}

function propertiesOf(schema) {
  return isPlainObject(schema.properties) ? schema.properties : {};
}

function requiredSet(schema) {
  return new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
}

function hasProperties(schema) {
  return isPlainObject(schema) && isPlainObject(schema.properties);
}

function requireObject(v, name) {
  const parsed = typeof v === "string" ? tryParse(v) : v;
  if (!isPlainObject(parsed)) {
    throw new Error(`input '${name}' is required and must be a JSON Schema object`);
  }
  return parsed;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

function normalizeSamples(v) {
  if (v == null) return [];
  const parsed = typeof v === "string" ? tryParse(v) : v;
  if (Array.isArray(parsed)) return parsed;
  if (isPlainObject(parsed)) return [parsed];
  return [];
}

function normalizePolicy(v) {
  const p = asObject(typeof v === "string" ? tryParse(v) : v);
  return {
    breaking_allowed: p.breaking_allowed === true,
    required_fields: Array.isArray(p.required_fields) ? p.required_fields.map(String) : [],
    versioning_rule: typeof p.versioning_rule === "string" ? p.versioning_rule : "additive-only",
  };
}

// ---------------------------------------------------------------------------
// schema diff
// ---------------------------------------------------------------------------

// integer is a subset of number, so integer -> number widens the contract and is
// not breaking. Everything else that changes a declared type is breaking.
function isWidening(oldType, newType) {
  return oldType === "integer" && newType === "number";
}

function policyRuleFor(fieldPath, policy) {
  if (policy.required_fields.includes(fieldPath)) {
    return `required_fields policy: '${fieldPath}' must remain present and required`;
  }
  return policy.breaking_allowed
    ? "breaking_allowed=true (flagged, permitted by policy)"
    : `versioning_rule '${policy.versioning_rule}' forbids breaking changes`;
}

function diffSchemas(current, proposed, policy, prefix = "", depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(`schema nesting exceeds ${MAX_DEPTH} levels`);
  const breaking = [];
  const additive = [];
  const curProps = propertiesOf(current);
  const propProps = propertiesOf(proposed);
  const curReq = requiredSet(current);
  const propReq = requiredSet(proposed);

  for (const key of Object.keys(curProps)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    const cur = asObject(curProps[key]);

    if (propProps[key] === undefined) {
      breaking.push({
        field_path: fieldPath,
        kind: "field_removed",
        old_contract: describeField(cur, curReq.has(key)),
        new_contract: "(absent)",
        policy_rule: policyRuleFor(fieldPath, policy),
      });
      continue;
    }
    const prop = asObject(propProps[key]);

    if (cur.type && prop.type && cur.type !== prop.type && !isWidening(cur.type, prop.type)) {
      breaking.push({
        field_path: fieldPath,
        kind: "type_changed",
        old_contract: `type=${cur.type}`,
        new_contract: `type=${prop.type}`,
        policy_rule: policyRuleFor(fieldPath, policy),
      });
    }

    if (Array.isArray(cur.enum) && Array.isArray(prop.enum)) {
      const propEnum = new Set(prop.enum.map(canonical));
      const removed = cur.enum.filter((v) => !propEnum.has(canonical(v)));
      if (removed.length > 0) {
        breaking.push({
          field_path: fieldPath,
          kind: "enum_values_removed",
          old_contract: `enum ${JSON.stringify(cur.enum)}`,
          new_contract: `enum ${JSON.stringify(prop.enum)}`,
          policy_rule: policyRuleFor(fieldPath, policy),
        });
      }
    }

    if (!curReq.has(key) && propReq.has(key)) {
      breaking.push({
        field_path: fieldPath,
        kind: "field_made_required",
        old_contract: "optional",
        new_contract: "required",
        policy_rule: policyRuleFor(fieldPath, policy),
      });
    } else if (curReq.has(key) && !propReq.has(key)) {
      additive.push({ field_path: fieldPath, kind: "field_made_optional" });
    }

    // Recurse whenever either side declares nested properties, whether or not a
    // `type: object` keyword is present (JSON Schema does not require it).
    if (hasProperties(cur) || hasProperties(prop)) {
      const nested = diffSchemas(cur, prop, policy, fieldPath, depth + 1);
      breaking.push(...nested.breaking);
      additive.push(...nested.additive);
    }
  }

  for (const key of Object.keys(propProps)) {
    if (curProps[key] !== undefined) continue;
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    const prop = asObject(propProps[key]);
    if (propReq.has(key) && prop.default === undefined) {
      breaking.push({
        field_path: fieldPath,
        kind: "required_field_added",
        old_contract: "(absent)",
        new_contract: `required ${prop.type || "field"}`,
        policy_rule: policyRuleFor(fieldPath, policy),
      });
    } else {
      additive.push({ field_path: fieldPath, kind: "optional_field_added" });
    }
  }

  return { breaking, additive };
}

function describeField(field, required) {
  const t = field && field.type ? `type=${field.type}` : "field";
  return required ? `required ${t}` : `optional ${t}`;
}

// A required_fields entry must remain present AND required in the proposed schema.
// This is checked independently of the breaking list so a required->optional
// demotion (which is otherwise a widening) still blocks when the field is pinned.
function requiredFieldViolations(proposed, requiredFields) {
  const violations = [];
  for (const fieldPath of requiredFields) {
    const state = resolveFieldState(proposed, String(fieldPath));
    if (!state.present || !state.required) violations.push(fieldPath);
  }
  return violations;
}

function resolveFieldState(schema, dottedPath) {
  const parts = dottedPath.split(".");
  let node = schema;
  for (let i = 0; i < parts.length; i++) {
    const props = propertiesOf(node);
    const key = parts[i];
    if (!(key in props)) return { present: false, required: false };
    if (i === parts.length - 1) {
      return { present: true, required: requiredSet(node).has(key) };
    }
    node = asObject(props[key]);
  }
  return { present: false, required: false };
}

// ---------------------------------------------------------------------------
// payload validation (minimal, deterministic JSON-Schema subset)
// ---------------------------------------------------------------------------

function validatePayload(payload, schema, prefix = "", depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(`payload nesting exceeds ${MAX_DEPTH} levels`);
  const errors = [];
  if (!isPlainObject(payload)) {
    return { valid: false, errors: [`${prefix || "payload"} is not an object`] };
  }
  const props = propertiesOf(schema);
  for (const req of Array.isArray(schema.required) ? schema.required : []) {
    if (payload[req] === undefined) {
      errors.push(`missing required field '${prefix ? prefix + "." : ""}${req}'`);
    }
  }
  for (const [key, val] of Object.entries(payload)) {
    const spec = props[key];
    if (!isPlainObject(spec)) continue;
    const fp = prefix ? `${prefix}.${key}` : key;
    if (spec.type && !typeMatches(val, spec.type)) {
      errors.push(`field '${fp}' expected type ${spec.type}, got ${jsonType(val)}`);
    }
    if (Array.isArray(spec.enum) && !spec.enum.some((e) => canonical(e) === canonical(val))) {
      errors.push(`field '${fp}' value ${JSON.stringify(val)} not in enum ${JSON.stringify(spec.enum)}`);
    }
    if (hasProperties(spec) && isPlainObject(val)) {
      errors.push(...validatePayload(val, spec, fp, depth + 1).errors);
    }
  }
  return { valid: errors.length === 0, errors };
}

function jsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function typeMatches(v, type) {
  switch (type) {
    case "integer": return Number.isInteger(v);
    case "number": return typeof v === "number";
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    case "object": return isPlainObject(v);
    case "array": return Array.isArray(v);
    case "null": return v === null;
    default: return true;
  }
}

// ---------------------------------------------------------------------------
// packet assembly
// ---------------------------------------------------------------------------

function buildPacket({ current, proposed, breaking, additive, validationResults, policy }) {
  const policyViolations = requiredFieldViolations(proposed, policy.required_fields);
  const sampleFailures = validationResults.filter((r) => !r.valid);

  const compatible =
    policyViolations.length === 0 &&
    sampleFailures.length === 0 &&
    (breaking.length === 0 || policy.breaking_allowed === true);

  const migrationNotes = [];
  for (const b of breaking) {
    migrationNotes.push(`${b.kind} at '${b.field_path}': ${b.old_contract} -> ${b.new_contract}. ${b.policy_rule}.`);
  }
  for (const fp of policyViolations) {
    migrationNotes.push(`required_fields policy: '${fp}' must remain present and required in the proposed schema, but it is removed or relaxed.`);
  }
  for (const r of sampleFailures) {
    migrationNotes.push(`sample_payloads[${r.payload_index}] fails against the proposed schema: ${r.errors.join("; ")}`);
  }
  if (compatible && additive.length > 0) {
    migrationNotes.push(`Additive-only change (${additive.length} field(s) added or relaxed); existing consumers remain valid.`);
  }

  const proposedDigest = `sha256:${sha256(canonical(proposed))}`;
  const publishProposal = compatible
    ? {
        decision: "proposed",
        performed_by: PUBLISH_EXECUTOR,
        requires_approval: true,
        to_schema_digest: proposedDigest,
        versioning_rule: policy.versioning_rule,
        note: `Proposal only. schema-guard performs no live schema write; the ${PUBLISH_EXECUTOR} executor applies the schema after approval.`,
      }
    : null;

  return {
    schema: SCHEMA,
    skill: SKILL,
    version: VERSION,
    block: !compatible,
    compatibility: {
      compatible,
      breaking_changes: breaking,
      breaking_allowed: policy.breaking_allowed,
      versioning_rule: policy.versioning_rule,
      required_fields: policy.required_fields,
      policy_violations: policyViolations,
    },
    validation_results: validationResults,
    migration_notes: migrationNotes,
    publish_schema_proposal: publishProposal,
    summary: {
      breaking_count: breaking.length,
      additive_count: additive.length,
      policy_violation_count: policyViolations.length,
      samples_validated: validationResults.length,
      samples_failed: sampleFailures.length,
      proposal_status: publishProposal ? "proposed" : "withheld",
    },
    policy,
    source: {
      current_schema_sha256: `sha256:${sha256(canonical(current))}`,
      proposed_schema_sha256: proposedDigest,
    },
    validation: {
      grounded_in_schemas: true,
      proposal_iff_compatible: (publishProposal != null) === compatible,
      breaking_changes_have_field_paths: breaking.every((b) => typeof b.field_path === "string" && b.field_path.length > 0),
      required_fields_enforced: policyViolations.length === 0 || !compatible,
      no_live_schema_write: true,
      finding_rule:
        "A breaking change is reported only when the proposed schema removes, narrows, or newly requires a field relative to the current schema; a pinned required_fields entry that is removed or demoted always blocks; a publish_schema_proposal is emitted only when the change is compatible under the policy; the skill never writes a live schema.",
    },
  };
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

function writeArtifacts(outputDir, packet, root) {
  if (!outputDir) return;
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, "evidence.json"), `${JSON.stringify(packet, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "report.md"), renderReport(packet));
}

function renderReport(packet) {
  const c = packet.compatibility;
  const lines = [];
  lines.push("# Schema Guard Report");
  lines.push("");
  lines.push(`- Scanner: ${packet.skill} v${packet.version}`);
  lines.push(`- Compatible: ${c.compatible}`);
  lines.push(`- Breaking changes: ${packet.summary.breaking_count}`);
  lines.push(`- Policy violations: ${packet.summary.policy_violation_count}`);
  lines.push(`- Additive changes: ${packet.summary.additive_count}`);
  lines.push(`- Samples validated: ${packet.summary.samples_validated} (failed: ${packet.summary.samples_failed})`);
  lines.push(`- Proposal: ${packet.summary.proposal_status}`);
  lines.push(`- Versioning rule: ${c.versioning_rule} | breaking_allowed: ${c.breaking_allowed}`);
  lines.push("");
  lines.push("## Breaking changes");
  lines.push("");
  if (c.breaking_changes.length === 0) {
    lines.push("None. The proposed schema does not remove, narrow, or newly require any field.");
  } else {
    lines.push("| Field | Kind | Old contract | New contract | Policy rule |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const b of c.breaking_changes) {
      lines.push(`| ${b.field_path} | ${b.kind} | ${b.old_contract} | ${b.new_contract} | ${b.policy_rule} |`);
    }
  }
  lines.push("");
  lines.push("## Migration notes");
  lines.push("");
  if (packet.migration_notes.length === 0) lines.push("No migration action required.");
  else for (const n of packet.migration_notes) lines.push(`- ${n}`);
  lines.push("");
  lines.push("## Guarantees");
  lines.push("");
  lines.push("- Breaking changes are grounded only in the current vs proposed schema diff.");
  lines.push("- A pinned required_fields entry that is removed or demoted always blocks.");
  lines.push("- A publish_schema_proposal is emitted only when the change is compatible under the policy.");
  lines.push(`- The proposal is gated: performed_by=${PUBLISH_EXECUTOR}, requires_approval=true.`);
  lines.push("- schema-guard writes no live schema; publishing is the gated executor's effect.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ensureInside(root, resolved, label) {
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`${label} must stay inside the skill directory`);
  }
}

// Deterministic key-sorted serialization so a schema digest is stable regardless
// of key order. undefined is normalized to null to keep the string well-formed.
function canonical(value) {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

try {
  main();
} catch (err) {
  process.stderr.write(`schema-guard: ${err && err.message ? err.message : err}\n`);
  process.exit(64);
}
