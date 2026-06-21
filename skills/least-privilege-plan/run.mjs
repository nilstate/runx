import fs from "node:fs";

const input = readInputs();
const history = obj(input.run_history_packet);
const policy = obj(input.declared_policy);
const grants = Array.isArray(history.grants) ? history.grants : [];
const effects = Array.isArray(history.observed_effects) ? history.observed_effects : [];

if (grants.length === 0) {
  emit({
    status: "needs_input",
    keep: [],
    reduce: [],
    revoke: [],
    needs_human_review: [{ action: "needs_human_review", rationale: "run_history_packet.grants is required" }],
    evidence: { read_only: true },
    reviewer_notes: ["Provide grants before planning least privilege."],
  });
}

const recommendations = grants.map((grant, index) => classifyGrant(grant, index));
emit({
  status: recommendations.some((entry) => entry.action === "needs_human_review") ? "needs_human_review" : "ready",
  keep: recommendations.filter((entry) => entry.action === "keep"),
  reduce: recommendations.filter((entry) => entry.action === "reduce"),
  revoke: recommendations.filter((entry) => entry.action === "revoke"),
  needs_human_review: recommendations.filter((entry) => entry.action === "needs_human_review"),
  evidence: {
    policy_id: text(policy.id) || "inline_policy",
    grant_ids: grants.map((grant, index) => text(grant.id) || `grant_${index + 1}`),
    observed_effect_count: effects.length,
    unused_scopes: recommendations.filter((entry) => entry.action === "revoke").map((entry) => entry.scope),
    read_only: true,
  },
  reviewer_notes: notes(recommendations),
});

function classifyGrant(grant, index) {
  const grantId = text(grant?.id) || `grant_${index + 1}`;
  const scope = text(grant?.scope);
  if (!scope) return rec("needs_human_review", grantId, "unknown", [], "Grant scope is missing.", null);
  const observed = effects.filter((effect) => covers(scope, text(effect?.scope)));
  const required = Array.isArray(policy.required_scopes) && policy.required_scopes.includes(scope);
  if (observed.length === 0 && !required) return rec("revoke", grantId, scope, [], "No observed effect or declared policy requirement cited this scope.", null);
  if (scope.endsWith("*") && observed.length === 1) {
    const narrower = text(observed[0].scope);
    if (narrower && narrower !== scope) return rec("reduce", grantId, scope, observed, "Observed effects fit one narrower scope than the wildcard grant.", narrower);
  }
  return rec("keep", grantId, scope, observed, required ? "Declared policy marks this scope as required." : "Observed effects cite this scope.", scope);
}

function rec(action, grantId, scope, observed, rationale, proposedScope) {
  return {
    action,
    grant_id: grantId,
    scope,
    proposed_scope: proposedScope,
    cited_effects: observed.map((effect) => ({ id: text(effect.id) || "effect", scope: text(effect.scope) || "unknown", summary: text(effect.summary) || "observed effect" })),
    rationale,
  };
}

function notes(items) {
  const out = [];
  if (items.some((entry) => entry.action === "reduce")) out.push("Wildcard grants have narrower observed alternatives.");
  if (items.some((entry) => entry.action === "revoke")) out.push("Unused grants can be removed after operator review.");
  if (items.some((entry) => entry.action === "needs_human_review")) out.push("Some grants need policy semantics before changing.");
  return out.length ? out : ["Observed effects match the declared grants."];
}

function covers(scope, effectScope) { return Boolean(scope && effectScope && (scope === effectScope || (scope.endsWith("*") && effectScope.startsWith(scope.slice(0, -1))))); }
function readInputs() { if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")); if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON); return {}; }
function obj(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function emit(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); process.exit(0); }

