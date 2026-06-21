import fs from "node:fs";
import path from "node:path";

const SCHEMA = "runx.least_privilege_plan.v1";
const inputs = readInputs();
const skillRoot = process.cwd();

const policy = normalizePolicy(inputs.policy);
const history = normalizeHistory(inputs.run_history);
const plan = buildPlan({ policy, history });
const report = renderReport(plan);

writeArtifacts(inputs.output_dir, plan, report, skillRoot);
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function normalizePolicy(rawValue) {
  const parsed = parseMaybeJson(rawValue);
  const policy = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  return {
    policy_id: stringValue(policy.policy_id) || stringValue(policy.id),
    required_scopes: normalizeStringArray(policy.required_scopes),
    optional_scopes: normalizeStringArray(policy.optional_scopes),
  };
}

function normalizeHistory(rawValue) {
  const parsed = parseMaybeJson(rawValue);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry) => entry && typeof entry === "object")
    .map((entry, index) => ({
      grant_id: stringValue(entry.grant_id) || `grant-${index + 1}`,
      granted_scopes: normalizeStringArray(entry.granted_scopes),
      observed_effects: normalizeEffects(entry.observed_effects),
      evidence_refs: normalizeStringArray(entry.evidence_refs),
    }));
}

function buildPlan({ policy, history }) {
  const base = {
    schema: SCHEMA,
    decision: "ready",
    policy_id: policy.policy_id,
    keep: [],
    reduce: [],
    revoke: [],
    needs_human_review: [],
    evidence: {
      observed_effects: [],
      unused_scopes: [],
      missing_evidence: [],
    },
    read_only: true,
  };

  if (!policy.policy_id || history.length === 0) {
    return {
      ...base,
      decision: "needs_more_evidence",
      evidence: {
        ...base.evidence,
        missing_evidence: [{
          field: !policy.policy_id ? "policy.policy_id" : "run_history",
          reason: "A policy id and at least one run history record are required.",
        }],
      },
    };
  }

  const required = new Set(policy.required_scopes);
  const optional = new Set(policy.optional_scopes);

  for (const run of history) {
    const observedScopes = new Set(run.observed_effects.map((effect) => effect.scope));
    for (const effect of run.observed_effects) {
      base.evidence.observed_effects.push({
        grant_id: run.grant_id,
        scope: effect.scope,
        operation: effect.operation,
        evidence_ref: effect.evidence_ref,
      });
    }

    for (const granted of run.granted_scopes) {
      const observed = observedScopes.has(granted);
      const narrower = narrowerObservedScope(granted, observedScopes);
      if (observed) {
        base.keep.push(recommendation(run, granted, granted, "Observed effect used the granted scope."));
      } else if (narrower) {
        base.reduce.push(recommendation(run, granted, narrower, `Observed effects used ${narrower}, not ${granted}.`));
      } else if (required.has(granted)) {
        base.needs_human_review.push(recommendation(run, granted, granted, "Scope is required by policy but has no observed effect in the supplied history."));
      } else if (optional.has(granted) || policy.optional_scopes.length === 0) {
        base.revoke.push(recommendation(run, granted, "", "Optional scope has no observed effect in the supplied history."));
        base.evidence.unused_scopes.push({ grant_id: run.grant_id, scope: granted });
      } else {
        base.needs_human_review.push(recommendation(run, granted, granted, "Scope is neither required nor optional in policy; reviewer must decide."));
      }
    }
  }

  return base;
}

function recommendation(run, fromScope, toScope, reason) {
  return {
    grant_id: run.grant_id,
    from_scope: fromScope,
    to_scope: toScope,
    reason,
    evidence_refs: run.evidence_refs,
  };
}

function narrowerObservedScope(granted, observedScopes) {
  const pairs = {
    "repo:write": "repo:read",
    "payment:spend": "payment:quote",
    "email:send": "email:draft",
    "secrets:write": "secrets:read",
  };
  const candidate = pairs[granted];
  return candidate && observedScopes.has(candidate) ? candidate : "";
}

function normalizeEffects(rawValue) {
  const parsed = parseMaybeJson(rawValue);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((effect) => effect && typeof effect === "object")
    .map((effect, index) => ({
      scope: stringValue(effect.scope),
      operation: stringValue(effect.operation) || stringValue(effect.verb) || "observe",
      evidence_ref: stringValue(effect.evidence_ref) || stringValue(effect.receipt_ref) || `effect-${index + 1}`,
    }))
    .filter((effect) => effect.scope);
}

function renderReport(plan) {
  const lines = [
    "# Least Privilege Plan",
    "",
    `Decision: ${plan.decision}`,
    `Policy: ${plan.policy_id || "missing"}`,
    `Read only: ${plan.read_only}`,
    "",
    "## Keep",
    ...renderRecommendations(plan.keep),
    "",
    "## Reduce",
    ...renderRecommendations(plan.reduce),
    "",
    "## Revoke",
    ...renderRecommendations(plan.revoke),
    "",
    "## Needs Human Review",
    ...renderRecommendations(plan.needs_human_review),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function renderRecommendations(entries) {
  if (!entries.length) return ["- None."];
  return entries.map((entry) => `- ${entry.grant_id}: ${entry.from_scope}${entry.to_scope ? ` -> ${entry.to_scope}` : ""} (${entry.reason})`);
}

function writeArtifacts(outputDir, evidence, report, root) {
  if (typeof outputDir !== "string" || outputDir.trim() === "") return;
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "report.md"), report);
}

function ensureInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the skill directory`);
  }
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map((entry) => stringValue(entry)).filter(Boolean);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((entry) => stringValue(entry)).filter(Boolean);
    } catch {
      return value.split(",").map((entry) => entry.trim()).filter(Boolean);
    }
  }
  return [];
}

function parseMaybeJson(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
