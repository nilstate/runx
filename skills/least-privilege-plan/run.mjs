import fs from "node:fs";

const inputs = readInputs();
const subject = stringValue(inputs.subject) || "unknown";
const grants = stringArray(inputs.grants, "grants");
const runHistory = readRunHistory(inputs.run_history);
const policyConstraints = readPolicyConstraints(inputs.policy_constraints);
const observed = collectObservedUsage(runHistory);

const grantPlan = grants.map((grant) =>
  classifyGrant(grant, observed, policyConstraints)
);
const revokedGrants = grantPlan
  .filter((entry) => entry.classification === "revoke")
  .map((entry) => entry.declared_grant);
const reducedGrants = grantPlan
  .filter((entry) => entry.classification === "reduce" && entry.proposed_grant)
  .map((entry) => ({ from: entry.declared_grant, to: entry.proposed_grant }));
const keptGrants = grantPlan
  .filter((entry) => entry.classification === "keep")
  .map((entry) => entry.declared_grant);
const deferredGrants = grantPlan
  .filter((entry) => entry.classification === "needs_human_review")
  .map((entry) => entry.declared_grant);
const plannedGrantSet = [
  ...keptGrants,
  ...reducedGrants.map((entry) => entry.to),
  ...deferredGrants,
];

const limitations = [];
if (observed.size === 0) {
  limitations.push(
    "No observed grant usage was provided; the plan cannot safely narrow grants."
  );
}

const status =
  observed.size === 0
    ? "needs_more_evidence"
    : revokedGrants.length > 0 || reducedGrants.length > 0
      ? "plan_proposed"
      : "no_change";

const packet = {
  status,
  subject,
  evidence: {
    receipt_ids: Array.isArray(runHistory.receipt_ids)
      ? runHistory.receipt_ids.map(String)
      : [],
    receipt_window: stringValue(runHistory.receipt_window) || null,
    grant_source: stringValue(inputs.grant_source) || null,
    limitations,
  },
  grant_plan: grantPlan,
  planned_grant_set: plannedGrantSet,
  revoked_grants: revokedGrants,
  reduced_grants: reducedGrants,
  kept_grants: keptGrants,
  deferred_grants: deferredGrants,
  residual_risk: residualRisk({ keptGrants, deferredGrants, limitations }),
  reviewer_action:
    status === "plan_proposed"
      ? "apply_now"
      : status === "needs_more_evidence"
        ? "gather_more_receipts"
        : "none",
  receipt_expectations: {
    classification_counts: countClassifications(grantPlan),
    stop_status: status,
    unresolved_questions: limitations,
  },
};

const result = {
  grant_plan: packet,
  plan_summary: [
    ...revokedGrants.map((grant) => ({
      action: "revoke",
      grant,
      rationale: "No cited receipt exercised this authority.",
    })),
    ...reducedGrants.map((entry) => ({
      action: "reduce",
      from: entry.from,
      to: entry.to,
      rationale: "Observed use fits the narrower grant.",
    })),
  ],
  verdict: renderVerdict(packet),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

// --- helpers ---

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function readRunHistory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "run_history must be an object with receipt_ids and observed usage"
    );
  }
  return value;
}

function readPolicyConstraints(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { reserved_grants: [] };
  }
  return {
    reserved_grants: Array.isArray(value.reserved_grants)
      ? value.reserved_grants.map(String)
      : [],
  };
}

function stringArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${field} entries must be non-empty strings`);
    }
    return entry.trim();
  });
}

function collectObservedUsage(history) {
  const observed = new Map();
  const entries = Array.isArray(history.observed) ? history.observed : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const grant = stringValue(entry.grant);
    if (!grant) continue;
    const current = observed.get(grant) || { count: 0, refs: [] };
    current.count += Number.isFinite(entry.count)
      ? Math.max(0, Math.trunc(entry.count))
      : 1;
    if (Array.isArray(entry.refs))
      current.refs.push(...entry.refs.map(String));
    observed.set(grant, current);
  }
  return observed;
}

function classifyGrant(grant, observed, policyConstraints) {
  const normalized = normalizeGrant(grant);

  // Check if this is a policy-reserved grant
  if (policyConstraints.reserved_grants.includes(grant)) {
    return planEntry({
      grant,
      normalized,
      observedUse: observed.get(grant) || { count: 0, refs: [] },
      classification: "needs_human_review",
      proposedGrant: null,
      rationale:
        "Grant is marked as policy-reserved; human review required before any change.",
      operationalRisk:
        "Removing a policy-reserved grant may violate compliance requirements.",
    });
  }

  // Exact match — grant is exercised as declared
  const exact = observed.get(grant);
  if (exact && exact.count > 0) {
    return planEntry({
      grant,
      normalized,
      observedUse: { count: exact.count, receipt_refs: exact.refs },
      classification: "keep",
      proposedGrant: null,
      rationale: "Observed receipt usage exercised this exact authority.",
      operationalRisk: "None.",
    });
  }

  // Check for narrower observed usage under a wildcard grant
  const narrower = observedNarrowerGrant(grant, observed);
  if (narrower) {
    const proposed =
      commonGrantPrefix(narrower.grants) || narrower.grants[0];
    return planEntry({
      grant,
      normalized,
      observedUse: {
        count: narrower.count,
        receipt_refs: narrower.refs,
        grants: narrower.grants,
      },
      classification: "reduce",
      proposedGrant: proposed,
      rationale:
        "Observed usage fits a narrower grant than the declared wildcard.",
      operationalRisk:
        "Low — a future use outside the narrowed scope would re-request the broader grant.",
    });
  }

  // No observed usage at all
  return planEntry({
    grant,
    normalized,
    observedUse: { count: 0, receipt_refs: [] },
    classification: "revoke",
    proposedGrant: null,
    rationale: "No cited receipt exercised this authority.",
    operationalRisk: "Low — removal cannot break observed behavior.",
  });
}

function observedNarrowerGrant(grant, observed) {
  if (!grant.endsWith("*")) return null;
  const prefix = grant.slice(0, -1);
  const matches = [...observed.entries()].filter(([used]) =>
    used.startsWith(prefix)
  );
  if (matches.length === 0) return null;
  return {
    grants: matches.map(([used]) => used),
    count: matches.reduce((sum, [, usage]) => sum + usage.count, 0),
    refs: matches.flatMap(([, usage]) => usage.refs),
  };
}

function normalizeGrant(grant) {
  const [actionPart, ...resourceParts] = grant.split(":");
  const resource = resourceParts.join(":") || null;
  return {
    action: actionPart || null,
    resource,
    conditions: null,
  };
}

function planEntry({
  grant,
  normalized,
  observedUse,
  classification,
  proposedGrant,
  rationale,
  operationalRisk,
}) {
  return {
    declared_grant: grant,
    normalized,
    observed_use: {
      count: observedUse.count,
      actions: normalized.action ? [normalized.action] : [],
      resources: normalized.resource ? [normalized.resource] : [],
      receipt_refs: observedUse.receipt_refs || [],
    },
    classification,
    proposed_grant: proposedGrant,
    rationale,
    operational_risk: operationalRisk,
  };
}

function commonGrantPrefix(grants) {
  if (grants.length !== 1) return null;
  return grants[0];
}

function countClassifications(entries) {
  return entries.reduce((counts, entry) => {
    counts[entry.classification] = (counts[entry.classification] || 0) + 1;
    return counts;
  }, {});
}

function residualRisk({ keptGrants, deferredGrants, limitations }) {
  const risks = [];
  if (keptGrants.length > 0) {
    risks.push(
      `The subject still retains ${keptGrants.length} observed grant(s).`
    );
  }
  if (deferredGrants.length > 0) {
    risks.push(
      `The subject has ${deferredGrants.length} grant(s) requiring human review.`
    );
  }
  risks.push(...limitations);
  return risks;
}

function renderVerdict(packet) {
  if (packet.status === "plan_proposed") {
    return `over-privileged: revoke ${packet.revoked_grants.length}, reduce ${packet.reduced_grants.length}`;
  }
  if (packet.status === "needs_more_evidence") {
    return "needs_more_evidence: no exercised grants were provided";
  }
  return "no_change: observed usage matches the declared grants";
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
