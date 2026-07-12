import fs from "node:fs";

const mode = process.argv[2];
const inputs = readInputs();

if (mode === "evaluate") {
  process.stdout.write(JSON.stringify({ policy_review_packet: evaluate(inputs) }));
} else if (mode === "finalize") {
  process.stdout.write(JSON.stringify({ purchase_approval_packet: finalize(inputs) }));
} else {
  process.stderr.write("usage: node run.mjs <evaluate|finalize>\\n");
  process.exit(64);
}

function evaluate(inputs) {
  const request = objectValue(inputs.purchase_request);
  const policy = objectValue(inputs.procurement_policy);
  const budget = moneyValue(inputs.current_budget_balance);
  const scope = objectValue(inputs.requested_budget_bounded_scope);
  const requested = moneyValue({ amount: request.amount, currency: request.currency });
  const maxSingle = moneyValue(policy.max_single_purchase);
  const approvalThreshold = moneyValue(policy.requires_approval_above);
  const requestedCeiling = moneyValue(scope.ceiling);
  const vendor = text(request.vendor);
  const purpose = text(request.purpose);
  const counterparty = text(scope.counterparty);
  const scopes = strings(scope.scopes);
  const allowScopeDown = scope.allow_scope_down === true;
  const approvedVendors = strings(policy.approved_vendors);
  const violations = [];

  if (!requested || !vendor || !purpose) {
    violations.push("purchase_request must include a positive amount, currency, vendor, and purpose");
  }
  if (!maxSingle || !approvalThreshold || !budget) {
    violations.push("procurement_policy limits and current_budget_balance must be typed money objects");
  }
  if (requested && maxSingle && requested.currency !== maxSingle.currency) {
    violations.push(`currency mismatch: request is ${requested.currency} while max_single_purchase is ${maxSingle.currency}`);
  }
  if (requested && approvalThreshold && requested.currency !== approvalThreshold.currency) {
    violations.push(`currency mismatch: request is ${requested.currency} while requires_approval_above is ${approvalThreshold.currency}`);
  }
  if (requested && budget && requested.currency !== budget.currency) {
    violations.push(`currency mismatch: request is ${requested.currency} while budget is ${budget.currency}`);
  }
  if (vendor && !approvedVendors.includes(vendor)) {
    violations.push(`vendor ${vendor} is absent from procurement_policy.approved_vendors`);
  }

  const permittedAmount = requested && maxSingle && budget
    && requested.currency === maxSingle.currency
    && requested.currency === budget.currency
    ? Math.min(maxSingle.amount, budget.amount)
    : null;
  const needsScopeDown = requested && permittedAmount !== null && requested.amount > permittedAmount;
  const scopeDownAllowed = needsScopeDown && allowScopeDown;

  if (needsScopeDown && !allowScopeDown) {
    violations.push(`requested ${requested.amount} ${requested.currency} exceeds the permitted ${permittedAmount} ${requested.currency}; allow_scope_down must be true to propose a lower ceiling`);
  }
  if (requested && requestedCeiling && requested.currency !== requestedCeiling.currency) {
    violations.push(`currency mismatch: requested ceiling is ${requestedCeiling.currency} while request is ${requested.currency}`);
  }
  const expectedAmount = scopeDownAllowed ? permittedAmount : requested?.amount ?? null;
  if (!requestedCeiling || expectedAmount === null || requestedCeiling.amount !== expectedAmount || requestedCeiling.currency !== requested?.currency || counterparty !== vendor || scopes.length === 0) {
    violations.push("requested_budget_bounded_scope must match the approved ceiling, request currency, vendor, and include scopes");
  }
  if (!isCompleteAttenuationRequest(scope.attenuation_request, requestedCeiling, vendor, approvalThreshold, scopes)) {
    violations.push("requested_budget_bounded_scope.attenuation_request is incomplete or exceeds the proposed ceiling");
  }

  const allowed = violations.length === 0;
  const decisionMode = allowed ? (scopeDownAllowed ? "scope_down" : "approve_in_full") : "deny";
  const thresholdReached = requested && approvalThreshold && requested.amount > approvalThreshold.amount;
  const approvalReason = allowed
    ? `${decisionMode === "scope_down" ? "Scope down" : "Approve"} ${requestedCeiling.amount} ${requestedCeiling.currency} for ${vendor}. ${thresholdReached ? "The request exceeds the configured approval threshold." : "The graph requires human review before emitting the ceiling."}`
    : violations.join("; ");

  return {
    kind: "purchase_approval_policy_review",
    allowed,
    decision_mode: decisionMode,
    approval_required: true,
    approval_reason: approvalReason,
    violations,
    requested_amount: requested?.amount ?? null,
    requested_currency: requested?.currency ?? null,
    permitted_amount: allowed ? requestedCeiling.amount : null,
    ceiling: allowed ? requestedCeiling : null,
    vendor,
    approval_threshold: approvalThreshold,
    budget_balance: budget,
    scope_down_consent: allowScopeDown,
  };
}

function finalize(inputs) {
  const review = objectValue(inputs.policy_review);
  const approval = objectValue(inputs.approval_decision);
  const scope = objectValue(inputs.requested_budget_bounded_scope);
  const ceiling = moneyValue(review.ceiling);
  const vendor = text(review.vendor);
  const scopes = strings(scope.scopes);
  const approved = review.allowed === true
    && approval.approved === true
    && (review.decision_mode === "approve_in_full" || review.decision_mode === "scope_down")
    && Boolean(ceiling)
    && text(scope.counterparty) === vendor
    && isCompleteAttenuationRequest(
      scope.attenuation_request,
      ceiling,
      vendor,
      moneyValue(review.approval_threshold),
      scopes,
    );

  if (!approved) {
    const reason = review.allowed === true
      ? "Human approval was not granted, so no downstream ceiling can be emitted."
      : text(review.approval_reason) || "The deterministic purchase policy review failed.";
    return {
      kind: "purchase_approval_result",
      decision: { approved: false, mode: "deny", reason },
      attenuation_request: null,
      ceiling: null,
      escalation: {
        lane: "purchase_approval.review",
        reason,
        policy_violations: Array.isArray(review.violations) ? review.violations : [],
      },
    };
  }

  return {
    kind: "purchase_approval_result",
    decision: {
      approved: true,
      mode: review.decision_mode,
      reason: "The request passed deterministic purchase policy and the named human review task.",
    },
    attenuation_request: scope.attenuation_request,
    ceiling: {
      amount: ceiling.amount,
      currency: ceiling.currency,
      counterparty: vendor,
      scopes,
    },
    escalation: null,
  };
}

function isCompleteAttenuationRequest(value, ceiling, vendor, approvalThreshold, scopes) {
  if (!value || typeof value !== "object" || !ceiling || !vendor) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = ["bounds", "capabilities", "expires_at", "principal_ref", "resource_family", "resource_ref", "verbs"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return false;
  const bounds = objectValue(value.bounds);
  if (Object.keys(bounds).length !== 1 || !Object.hasOwn(bounds, "effect_limits")) return false;
  const limits = bounds.effect_limits;
  if (!Array.isArray(limits) || limits.length !== 1) return false;
  const limit = objectValue(limits[0]);
  const requestedVerbs = scopeVerbs(scopes);
  return referenceIs(value.principal_ref, "principal")
    && referenceIs(value.resource_ref, "surface", vendor)
    && value.resource_family === "effect"
    && requestedVerbs.length > 0
    && sameStrings(strings(value.verbs), requestedVerbs)
    && strings(value.capabilities).includes("effect_single_use_capability")
    && text(value.expires_at) !== null
    && limit.family === "payment"
    && limit.unit === ceiling.currency
    && limit.max_per_call_units === ceiling.amount
    && limit.max_per_run_units === ceiling.amount
    && strings(limit.channels).length > 0
    && text(limit.peer) === vendor
    && text(limit.operation) === "procurement.purchase"
    && approvalThreshold !== null
    && limit.approval_threshold_units === approvalThreshold.amount
    && limit.authorization_form === "single_use_capability"
    && limit.preflight_required === true
    && limit.commitment_required === true
    && limit.idempotency_required === true
    && limit.recovery_required === true
    && limit.receipt_before_success === true
    && limit.single_use_capability === true;
}

function referenceIs(value, type, uri) {
  const reference = objectValue(value);
  return reference.type === type && text(reference.uri) !== null && (!uri || reference.uri === uri);
}

function scopeVerbs(scopes) {
  const verbs = strings(scopes).map((scope) => {
    const match = /^payment:(prepare|commit)$/.exec(scope);
    return match?.[1] ?? null;
  });
  return verbs.some((verb) => verb === null) ? [] : verbs;
}

function sameStrings(left, right) {
  return left.length === right.length
    && new Set(left).size === left.length
    && left.every((value) => right.includes(value));
}

function moneyValue(value) {
  const money = objectValue(value);
  const amount = positiveNumber(money.amount);
  const currency = text(money.currency);
  return amount === null || !currency ? null : { amount, currency };
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function strings(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
