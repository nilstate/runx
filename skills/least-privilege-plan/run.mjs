import fs from "node:fs";
import crypto from "node:crypto";

const inputs = readInputs();
const history = requireObject(inputs.run_history_packet, "run_history_packet");
const policy = requireObject(inputs.policy, "policy");
const objective = stringValue(inputs.objective) || "Produce a least-privilege grant plan.";

const subject = stringValue(history.subject) || "unknown-subject";
const historyPolicyId = stringValue(history.policy_id);
const declaredPolicyId = stringValue(policy.policy_id);
if (!historyPolicyId) throw new Error("run_history_packet.policy_id is required");
if (!declaredPolicyId) throw new Error("policy.policy_id is required");
if (historyPolicyId !== declaredPolicyId) {
  throw new Error("run_history_packet.policy_id must match policy.policy_id");
}
const policyId = declaredPolicyId;
const grants = normalizeGrants(history.grants);
const effects = normalizeEffects(history.observed_effects);
const missingEvidence = normalizeMissingEvidence(history.missing_evidence);
const reservedGrantIds = new Set(arrayValue(policy.reserved_grants).map(String));
const reviewRules = isObject(policy.review_rules) ? policy.review_rules : {};

const recommendations = grants.map((grant) =>
  recommendGrant(grant, effects, missingEvidence, reservedGrantIds, reviewRules),
);

const counts = recommendations.reduce(
  (acc, rec) => {
    acc[rec.recommendation] = (acc[rec.recommendation] || 0) + 1;
    return acc;
  },
  { keep: 0, reduce: 0, revoke: 0, needs_human_review: 0 },
);

const status =
  counts.needs_human_review > 0
    ? "needs_human_review"
    : counts.reduce > 0 || counts.revoke > 0
      ? "attenuation_proposed"
      : "no_change";

const plan = {
  schema: "runx.security.least_privilege_plan.v1",
  status,
  subject,
  objective,
  policy_id: policyId,
  source_receipts: arrayValue(history.receipt_refs).map(String),
  recommendations,
  proposed_grants: recommendations
    .filter((rec) => rec.recommendation === "keep" || rec.recommendation === "reduce")
    .map((rec) => ({
      grant_id: rec.grant_id,
      scope: rec.proposed_scope || rec.current_scope,
      source: rec.recommendation,
    })),
  summary: {
    grant_count: grants.length,
    observed_effect_count: effects.length,
    recommendation_counts: counts,
  },
  safeguards: {
    read_only: true,
    mutates_grants: false,
    network_required: false,
    secrets_required: false,
  },
};

const evidenceJson = {
  schema: "frantic.delivery.evidence.v1",
  artifact: "least-privilege-plan",
  observations: {
    policy_id: policyId,
    policy_digest: sha256Json(policy),
    run_history_digest: sha256Json(history),
    subject,
    grant_ids: grants.map((grant) => grant.grant_id),
    observed_effects: effects.map((effect) => ({
      effect_id: effect.effect_id,
      grant_id: effect.grant_id,
      verb: effect.verb,
      resource: effect.resource,
      status: effect.status,
      receipt_ref: effect.receipt_ref,
    })),
    unused_scopes: recommendations
      .filter((rec) => rec.recommendation === "revoke")
      .map((rec) => ({ grant_id: rec.grant_id, scope: rec.current_scope })),
    recommendations: recommendations.map((rec) => ({
      grant_id: rec.grant_id,
      recommendation: rec.recommendation,
      proposed_scope: rec.proposed_scope,
      evidence_refs: rec.evidence_refs,
    })),
    receipt_refs: plan.source_receipts,
  },
};

const report = renderReport(plan);

process.stdout.write(`${JSON.stringify({ plan, recommendations, evidence_json: evidenceJson, report }, null, 2)}\n`);

function recommendGrant(grant, effects, missingEvidence, reservedGrantIds, reviewRules) {
  const grantEffects = effects.filter((effect) => effect.grant_id === grant.grant_id);
  const successEffects = grantEffects.filter((effect) => effect.status === "success");
  const deniedEffects = grantEffects.filter((effect) => effect.status === "denied");
  const missing = missingEvidence.filter((entry) => entry.grant_id === grant.grant_id);
  const policyRefs = [grant.declared_policy_ref].filter(Boolean);
  const evidenceRefs = grantEffects.map((effect) => effect.receipt_ref).filter(Boolean);

  if (missing.length > 0 || (deniedEffects.length > 0 && reviewRules.require_human_review_for_denied_secret)) {
    return buildRecommendation({
      grant,
      recommendation: "needs_human_review",
      proposedScope: null,
      observedEffects: grantEffects,
      evidenceRefs,
      policyRefs,
      unusedScopes: successEffects.length === 0 ? [grant.scope] : [],
      missingEvidence: missing.map((entry) => entry.reason),
      rationale:
        "The grant has missing or denied evidence that could change the attenuation decision; a policy owner must review it.",
      riskNotes: ["Do not revoke or reduce this grant automatically until the missing evidence is resolved."],
    });
  }

  if (reservedGrantIds.has(grant.grant_id)) {
    return buildRecommendation({
      grant,
      recommendation: "keep",
      proposedScope: null,
      observedEffects: grantEffects,
      evidenceRefs,
      policyRefs,
      unusedScopes: successEffects.length === 0 ? [grant.scope] : [],
      missingEvidence: [],
      rationale: "The declared policy marks this grant as reserved or break-glass authority.",
      riskNotes: ["Reserved grants remain broad by policy; schedule a separate human review if that posture changes."],
    });
  }

  if (successEffects.length === 0) {
    return buildRecommendation({
      grant,
      recommendation: "revoke",
      proposedScope: null,
      observedEffects: grantEffects,
      evidenceRefs,
      policyRefs,
      unusedScopes: [grant.scope],
      missingEvidence: [],
      rationale: "No successful observed effect exercised this grant in the supplied run history.",
      riskNotes: ["Revocation is safe only for the supplied evidence window; future workloads may require new authority."],
    });
  }

  const proposedScope = narrowerScope(grant.scope, successEffects);
  if (proposedScope && proposedScope !== grant.scope && reviewRules.wildcard_reduction_allowed !== false) {
    return buildRecommendation({
      grant,
      recommendation: "reduce",
      proposedScope,
      observedEffects: successEffects,
      evidenceRefs,
      policyRefs,
      unusedScopes: [grant.scope],
      missingEvidence: [],
      rationale: "Successful observed effects fit a narrower resource path than the current wildcard grant.",
      riskNotes: ["The reduced scope preserves only the cited resources from this evidence packet."],
    });
  }

  return buildRecommendation({
    grant,
    recommendation: "keep",
    proposedScope: null,
    observedEffects: successEffects,
    evidenceRefs,
    policyRefs,
    unusedScopes: [],
    missingEvidence: [],
    rationale: "Successful observed effects require the current grant as declared.",
    riskNotes: [],
  });
}

function buildRecommendation({
  grant,
  recommendation,
  proposedScope,
  observedEffects,
  evidenceRefs,
  policyRefs,
  unusedScopes,
  missingEvidence,
  rationale,
  riskNotes,
}) {
  return {
    grant_id: grant.grant_id,
    current_scope: grant.scope,
    recommendation,
    proposed_scope: proposedScope,
    observed_effects: observedEffects.map((effect) => ({
      effect_id: effect.effect_id,
      verb: effect.verb,
      resource: effect.resource,
      status: effect.status,
      receipt_ref: effect.receipt_ref,
    })),
    policy_input_refs: policyRefs,
    unused_scopes: unusedScopes,
    missing_evidence: missingEvidence,
    evidence_refs: evidenceRefs,
    rationale,
    risk_notes: riskNotes,
  };
}

function narrowerScope(scope, successEffects) {
  if (!scope.endsWith("*") || successEffects.length === 0) return null;
  const [verbPrefix, resourcePrefix = ""] = scope.slice(0, -1).split(/:(.*)/s);
  const resources = [...new Set(successEffects.map((effect) => effect.resource).filter(Boolean))];
  if (resources.length !== 1) return null;
  const observedResource = resources[0];
  if (!observedResource.startsWith(resourcePrefix)) return null;
  return `${verbPrefix}:${observedResource}`;
}

function normalizeGrants(value) {
  const grants = arrayValue(value).map((grant, index) => {
    if (!isObject(grant)) throw new Error(`grants[${index}] must be an object`);
    const grantId = stringValue(grant.grant_id) || `grant-${index + 1}`;
    const scope = stringValue(grant.scope);
    if (!scope) throw new Error(`grants[${index}].scope is required`);
    return {
      grant_id: grantId,
      scope,
      declared_policy_ref: stringValue(grant.declared_policy_ref),
    };
  });
  if (grants.length === 0) throw new Error("run_history_packet.grants must contain at least one grant");
  return grants;
}

function normalizeEffects(value) {
  return arrayValue(value).map((effect, index) => {
    if (!isObject(effect)) throw new Error(`observed_effects[${index}] must be an object`);
    return {
      effect_id: stringValue(effect.effect_id) || `effect-${index + 1}`,
      grant_id: stringValue(effect.grant_id) || "",
      verb: stringValue(effect.verb) || "",
      resource: stringValue(effect.resource) || "",
      status: normalizeStatus(effect.status, index),
      receipt_ref: stringValue(effect.receipt_ref) || "",
    };
  });
}

function normalizeMissingEvidence(value) {
  return arrayValue(value).map((entry, index) => {
    if (!isObject(entry)) throw new Error(`missing_evidence[${index}] must be an object`);
    return {
      grant_id: stringValue(entry.grant_id) || "",
      reason: stringValue(entry.reason) || "missing evidence",
    };
  });
}

function normalizeStatus(value, index) {
  const normalized = stringValue(value);
  if (!normalized) throw new Error(`observed_effects[${index}].status is required`);
  if (["success", "denied", "dry_run"].includes(normalized)) return normalized;
  throw new Error(`observed_effects[${index}].status must be success, denied, or dry_run`);
}

function renderReport(plan) {
  const lines = [
    `# least-privilege-plan report`,
    ``,
    `Subject: ${plan.subject}`,
    `Policy: ${plan.policy_id}`,
    `Status: ${plan.status}`,
    `Receipts: ${plan.source_receipts.join(", ") || "none supplied"}`,
    ``,
    `## Recommendations`,
    ...plan.recommendations.map(
      (rec) =>
        `- ${rec.recommendation}: ${rec.grant_id} ${rec.current_scope}` +
        (rec.proposed_scope ? ` -> ${rec.proposed_scope}` : "") +
        ` (${rec.rationale})`,
    ),
    ``,
    `Read-only: ${plan.safeguards.read_only}; mutates grants: ${plan.safeguards.mutates_grants}.`,
  ];
  return lines.join("\n");
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  if (!process.stdin.isTTY) {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) return JSON.parse(raw);
  }
  return {};
}

function requireObject(value, field) {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  return value;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sha256Json(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}`;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}
