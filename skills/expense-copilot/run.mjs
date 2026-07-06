function jsonInput(name, fallback = undefined) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name.toLowerCase()} must be valid JSON`);
  }
}

function stringField(object, key, label) {
  const value = String(object?.[key] ?? "").trim();
  if (!value) {
    return { ok: false, reason: `${label}.${key} is required` };
  }
  return { ok: true, value };
}

function amountField(object, key, label) {
  const value = Number(object?.[key]);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, reason: `${label}.${key} must be a non-negative number` };
  }
  return { ok: true, value };
}

function normalizeCategories(policy) {
  if (!Array.isArray(policy?.categories)) return [];
  return policy.categories.map((category) => String(category).trim()).filter(Boolean);
}

function categoryLimit(policy, category) {
  const limits = policy?.limits;
  if (!limits || typeof limits !== "object") {
    return { ok: false, reason: "policy.limits is required" };
  }
  const value = Number(limits[category]);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, reason: `policy.limits.${category} is missing or invalid` };
  }
  return { ok: true, value };
}

function extractReceipt(receipt) {
  const fields = {
    merchant: stringField(receipt, "merchant", "receipt"),
    amount: amountField(receipt, "amount", "receipt"),
    currency: stringField(receipt, "currency", "receipt"),
    category: stringField(receipt, "category", "receipt"),
    date: stringField(receipt, "date", "receipt"),
    employee_id: stringField(receipt, "employee_id", "receipt"),
  };
  const violations = Object.values(fields).filter((field) => !field.ok).map((field) => field.reason);
  const extracted = {
    merchant: fields.merchant.ok ? fields.merchant.value : null,
    amount: fields.amount.ok ? fields.amount.value : null,
    currency: fields.currency.ok ? fields.currency.value.toUpperCase() : null,
    category: fields.category.ok ? fields.category.value : null,
    date: fields.date.ok ? fields.date.value : null,
    employee_id: fields.employee_id.ok ? fields.employee_id.value : null,
    description: String(receipt?.description ?? "").trim() || null,
  };
  return { ok: violations.length === 0, extracted, violations };
}

function evaluate({ receipt, policy }) {
  const receiptResult = extractReceipt(receipt);
  const extracted = receiptResult.extracted;
  const violations = [...receiptResult.violations];
  const categories = normalizeCategories(policy);

  if (categories.length === 0) {
    violations.push("policy.categories must include at least one allowed category");
  }

  if (extracted.category && categories.length > 0 && !categories.includes(extracted.category)) {
    violations.push(`category ${extracted.category} is not allowed by policy`);
  }

  let limit = null;
  if (extracted.category && categories.includes(extracted.category)) {
    const limitResult = categoryLimit(policy, extracted.category);
    if (limitResult.ok) {
      limit = limitResult.value;
      if (extracted.amount !== null && extracted.amount > limit) {
        violations.push(`amount ${extracted.amount} exceeds ${extracted.category} limit ${limit}`);
      }
    } else {
      violations.push(limitResult.reason);
    }
  }

  const pass = violations.length === 0;
  const policyResult = {
    pass,
    violations,
    checked_category: extracted.category,
    category_limit: limit,
    allowed_categories: categories,
  };

  if (!pass) {
    return {
      status: "needs_agent",
      schema: "expense_copilot_result",
      package: "expense-copilot",
      version: "0.1.0",
      extracted,
      policy_result: policyResult,
      reimbursement_proposal: null,
      escalation: {
        lane: "finance.expense_review",
        reason: "expense_policy_failed",
        human_review_required: true,
      },
      dispatch_by_name: null,
      effects: {
        reimbursement_executed: false,
        money_rail: false,
        accounting_state_written: false,
      },
    };
  }

  return {
    status: "success",
    schema: "expense_copilot_result",
    package: "expense-copilot",
    version: "0.1.0",
    extracted,
    policy_result: policyResult,
    reimbursement_proposal: {
      packet: "reimbursement_proposal",
      employee_id: extracted.employee_id,
      merchant: extracted.merchant,
      amount: extracted.amount,
      currency: extracted.currency,
      category: extracted.category,
      date: extracted.date,
      justification: `Receipt is within ${extracted.category} limit ${limit}`,
      gated_effect: {
        downstream: "spend",
        proposed_effect: "reimbursement",
        requires_governed_spend_run: true,
      },
    },
    escalation: null,
    dispatch_by_name: {
      proposal_name: "reimbursement_proposal",
      downstream: "spend",
      delivery_rule: "spend may consume this proposal; expense-copilot never executes payment",
    },
    effects: {
      reimbursement_executed: false,
      money_rail: false,
      accounting_state_written: false,
    },
  };
}

function main() {
  const receipt = jsonInput("RECEIPT", {});
  const policy = jsonInput("POLICY", {});
  const output = evaluate({ receipt, policy });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
