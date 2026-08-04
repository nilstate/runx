export default function validateRoute(inputs) {
const catalog = record(inputs.available_sources);
const proposal = record(inputs.route_proposal);
const sources = indexed(catalog.sources, "source");
const owners = indexed(catalog.owners, "owner");
const skills = indexed(catalog.skills, "skill");
const verdict = String(proposal.verdict || "");

if (!["routed", "needs_more_context", "manual_review"].includes(verdict)) {
  throw new Error("verdict must be routed, needs_more_context, or manual_review");
}

const route = record(proposal.route);
const sourceRefs = stringArray(route.source_refs);
const sourceMatches = Array.isArray(proposal.source_matches) ? proposal.source_matches.map(record) : [];
const ownerRecommendation = record(proposal.owner_recommendation);
const nextSkill = record(proposal.next_skill);
const invalidRefs = [];

for (const ref of sourceRefs) {
  if (!sources.has(ref)) invalidRefs.push({ kind: "source", ref });
}
for (const match of sourceMatches) {
  const ref = stringValue(match.source_ref);
  if (!ref || !sources.has(ref)) invalidRefs.push({ kind: "source", ref: ref || "<missing>" });
}

const ownerRef = stringValue(ownerRecommendation.owner_ref);
if (ownerRef && !owners.has(ownerRef)) invalidRefs.push({ kind: "owner", ref: ownerRef });
const skillRef = stringValue(nextSkill.skill_ref);
if (skillRef && !skills.has(skillRef)) invalidRefs.push({ kind: "skill", ref: skillRef });

if (invalidRefs.length > 0) {
  return rejected("route contains references outside the supplied catalog", invalidRefs, inputs.constraints);
}
if (verdict === "routed" && sourceRefs.length === 0) {
  return rejected("a routed verdict requires at least one validated source reference", [], inputs.constraints);
}
if (verdict === "needs_more_context" && (sourceRefs.length > 0 || ownerRef || skillRef)) {
  return rejected("needs_more_context must not claim a source, owner, or follow-up skill", [], inputs.constraints);
}

const catalogDigest = stringValue(inputs.catalog_digest);
if (!catalogDigest || !/^sha256:[0-9a-f]{64}$/u.test(catalogDigest)) {
  return rejected("native catalog digest is missing", [], inputs.constraints);
}

return {
  knowledge_route: {
    schema: "runx.ops.knowledge_route.v1",
    verdict,
    route: {
      domain: stringValue(route.domain),
      rationale: stringValue(route.rationale),
      source_refs: sourceRefs,
    },
    source_matches: sourceMatches.map((match) => ({
      source_ref: stringValue(match.source_ref),
      matching_signal: stringValue(match.matching_signal),
      reason: stringValue(match.reason),
    })),
    owner_recommendation: ownerRef ? {
      owner_ref: ownerRef,
      rationale: stringValue(ownerRecommendation.rationale),
      escalation_required: ownerRecommendation.escalation_required === true,
    } : null,
    next_skill: skillRef ? {
      skill_ref: skillRef,
      rationale: stringValue(nextSkill.rationale),
    } : null,
    validation: {
      valid: true,
      catalog_digest: catalogDigest,
      invalid_refs: [],
      constraints_applied: inputs.constraints || null,
    },
  },
};
}

function indexed(value, label) {
  if (!Array.isArray(value)) throw new Error(`available_sources.${label}s must be an array`);
  const map = new Map();
  for (const raw of value) {
    const entry = record(raw);
    const id = stringValue(entry.id);
    if (!id) throw new Error(`every ${label} entry needs an id`);
    if (map.has(id)) throw new Error(`duplicate ${label} id: ${id}`);
    map.set(id, entry);
  }
  return map;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value) {
  return Array.isArray(value) ? [...new Set(value.map(stringValue).filter(Boolean))] : [];
}

function rejected(reason, findings, constraints) {
  return {
    knowledge_route: {
      schema: "runx.ops.knowledge_route.v1",
      verdict: "refused",
      route: {
        domain: null,
        rationale: reason,
        source_refs: [],
      },
      source_matches: [],
      owner_recommendation: null,
      next_skill: null,
      validation: {
        valid: false,
        catalog_digest: null,
        invalid_refs: findings,
        constraints_applied: constraints || null,
      },
    },
  };
}
