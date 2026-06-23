import crypto from "node:crypto";
import fs from "node:fs";

const inputs = readInputs();
const chargeReceipt = objectInput(inputs.charge_receipt, "charge_receipt");
const refundRequest = objectInput(inputs.refund_request, "refund_request");
const policy = objectInput(inputs.policy, "policy");

const decision = decide(chargeReceipt, refundRequest, policy);
process.stdout.write(`${JSON.stringify(decision.output, null, 2)}\n`);
if (!decision.ok) process.exit(64);

function decide(receipt, request, policyInput) {
  const chargeRef = stringValue(receipt.id)
    ?? stringValue(receipt.receipt_ref)
    ?? stringValue(receipt.charge_ref);
  const schema = stringValue(receipt.schema);
  const state = stringValue(receipt.state);
  const amount = numberValue(receipt.amount ?? receipt.amount_minor ?? receipt.total_amount);
  const alreadyRefunded = numberValue(receipt.refunded_amount ?? receipt.amount_refunded ?? 0) ?? 0;
  const currency = stringValue(receipt.currency);
  const chargedAt = dateValue(receipt.charged_at ?? receipt.created_at ?? receipt.timestamp);
  const requestedAt = dateValue(request.requested_at ?? policyInput.now ?? new Date().toISOString());
  const requestedAmount = numberValue(request.amount ?? request.amount_minor);
  const maxPct = numberValue(policyInput.max_pct);
  const windowDays = numberValue(policyInput.window_days);

  const base = {
    decision: { eligible: false, reason: "not_evaluated" },
    refundable: {
      charge_ref: chargeRef,
      amount,
      currency,
      already_refunded: alreadyRefunded,
      policy_cap: null,
      remaining_refundable: null,
      window_days: windowDays,
    },
    refund_proposal: null,
    escalation: null,
  };

  const missing = [];
  if (!chargeRef) missing.push("charge_ref");
  if (schema !== "runx.receipt.v1") missing.push("schema_runx_receipt_v1");
  if (state !== "sealed") missing.push("sealed_state");
  if (!Number.isFinite(amount) || amount <= 0) missing.push("charge_amount");
  if (!currency) missing.push("currency");
  if (!chargedAt) missing.push("charged_at");
  if (!requestedAt) missing.push("requested_at");
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) missing.push("refund_request.amount");
  if (!Number.isFinite(maxPct) || maxPct <= 0 || maxPct > 100) missing.push("policy.max_pct");
  if (!Number.isFinite(windowDays) || windowDays < 0) missing.push("policy.window_days");

  if (missing.length > 0) {
    return refused(base, "ambiguous_or_unsealed_charge", {
      lane: "human_refund_approval",
      required_evidence: missing,
      note: "The skill does not invent charge evidence or approve refunds from unsealed or ambiguous receipts.",
    });
  }

  const policyCap = Math.floor((amount * maxPct) / 100);
  const remainingByCharge = Math.max(0, amount - alreadyRefunded);
  const remainingByPolicy = Math.max(0, policyCap - alreadyRefunded);
  const remainingRefundable = Math.min(remainingByCharge, remainingByPolicy);
  base.refundable.policy_cap = policyCap;
  base.refundable.remaining_refundable = remainingRefundable;
  base.refundable.requested_amount = requestedAmount;

  const ageMs = requestedAt.getTime() - chargedAt.getTime();
  const ageDays = ageMs / 86_400_000;
  base.refundable.age_days = Number(ageDays.toFixed(4));

  if (ageMs < 0) {
    return refused(base, "request_before_charge", {
      lane: "human_refund_approval",
      required_evidence: ["valid requested_at after charged_at"],
    });
  }
  if (ageDays > windowDays) {
    return refused(base, "outside_policy_window", {
      lane: "support_policy_review",
      required_evidence: [`request age ${base.refundable.age_days}d exceeds ${windowDays}d window`],
    });
  }
  if (requestedAmount > remainingRefundable) {
    return refused(base, "amount_exceeds_remaining_refundable", {
      lane: "support_policy_review",
      required_evidence: [`requested ${requestedAmount} exceeds remaining ${remainingRefundable}`],
    });
  }

  const idempotencyKey = idempotency(chargeRef, requestedAmount, currency, stringValue(request.reason));
  const proposal = {
    amount: requestedAmount,
    currency,
    charge_ref: chargeRef,
    idempotency_key: idempotencyKey,
    effect: {
      kind: "refund_proposal",
      gated: true,
      consumer: "refund catalog skill",
      performs_money_movement: false,
    },
  };

  return {
    ok: true,
    output: {
      summary: `Refund request is eligible: ${requestedAmount} ${currency} against ${chargeRef}; proposal ${idempotencyKey}.`,
      decision: { eligible: true, reason: "in_policy" },
      refundable: base.refundable,
      refund_proposal: proposal,
      escalation: null,
    },
  };
}

function refused(base, reason, escalation) {
  return {
    ok: false,
    output: {
      summary: `Refund request refused: ${reason}. No refund proposal was emitted.`,
      decision: { eligible: false, reason },
      refundable: base.refundable,
      escalation,
    },
  };
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {
    charge_receipt: parseInputValue(process.env.RUNX_INPUT_CHARGE_RECEIPT),
    refund_request: parseInputValue(process.env.RUNX_INPUT_REFUND_REQUEST),
    policy: parseInputValue(process.env.RUNX_INPUT_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectInput(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    process.stderr.write(`${name} must be an object\n`);
    process.exit(64);
  }
  return value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function dateValue(value) {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : null;
}

function idempotency(chargeRef, amount, currency, reason) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ chargeRef, amount, currency, reason: reason ?? "" }))
    .digest("hex")
    .slice(0, 24);
  return `refund:${digest}`;
}
