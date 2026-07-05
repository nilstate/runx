import fs from "node:fs";
import { createHash } from "node:crypto";

const inputs = readInputs();

try {
  const output = judgeQuote(inputs);
  emit(output);
  if (output.status === "refused") {
    process.exitCode = 2;
  }
} catch (error) {
  emit(escalated(error.code ?? "invalid_input", error.message, []));
  process.exitCode = 2;
}

function judgeQuote(rawInputs) {
  const dealAsk = objectValue(rawInputs.deal_ask, "deal_ask");
  const policy = objectValue(rawInputs.account_policy, "account_policy");
  const quoteHistory = arrayValue(rawInputs.quote_history, "quote_history").map(normalizeHistoryRecord);

  const accountId = stringValue(dealAsk.account_id, "deal_ask.account_id");
  const product = stringValue(dealAsk.product, "deal_ask.product");
  const currency = stringValue(dealAsk.currency, "deal_ask.currency");
  const counterparty = normalizeCounterparty(dealAsk.counterparty);
  const listPriceUsd = positiveNumber(dealAsk.list_price_usd, "deal_ask.list_price_usd");
  const requestedNetUsd = positiveNumber(dealAsk.requested_net_usd, "deal_ask.requested_net_usd");
  const requestedDiscount = percentNumber(dealAsk.requested_discount_percent, "deal_ask.requested_discount_percent");
  const termMonths = positiveNumber(dealAsk.term_months, "deal_ask.term_months");
  const quantity = positiveNumber(dealAsk.quantity, "deal_ask.quantity");
  const margin = dealAsk.requested_margin_percent === undefined
    ? null
    : percentNumber(dealAsk.requested_margin_percent, "deal_ask.requested_margin_percent");

  validatePolicy(policy);
  const matchingHistory = quoteHistory.filter((record) => record.account_id === accountId && record.product === product);
  const priorQuoteEvidence = matchingHistory.map((record) => ({
    quote_id: record.quote_id,
    status: record.status,
    total_contract_value_usd: record.total_contract_value_usd,
    discount_percent: record.discount_percent,
    created_at: record.created_at,
  }));

  const base = {
    account_id: accountId,
    product,
    counterparty: {
      name: counterparty.name,
      contact: counterparty.contact,
    },
    requested: {
      currency,
      list_price_usd: roundMoney(listPriceUsd),
      requested_net_usd: roundMoney(requestedNetUsd),
      requested_discount_percent: roundPercent(requestedDiscount),
      term_months: termMonths,
      quantity,
      requested_margin_percent: margin === null ? null : roundPercent(margin),
    },
    prior_quote_evidence: priorQuoteEvidence,
  };

  const refusal = firstRefusal({ dealAsk, policy, product, currency, requestedNetUsd, requestedDiscount, margin });
  if (refusal) {
    return refused(refusal.reason_code, refusal.message, base, refusal.details);
  }

  const band = selectApprovalBand(policy.approval_bands, requestedDiscount, requestedNetUsd);
  if (!band) {
    return refused("outside_policy_band", "requested discount or total contract value exceeds supplied approval bands", base, {
      requested_discount_percent: roundPercent(requestedDiscount),
      requested_net_usd: roundMoney(requestedNetUsd),
      max_discount_percent: maxOf(policy.approval_bands, "max_discount_percent"),
      max_total_contract_value_usd: maxOf(policy.approval_bands, "max_total_contract_value_usd"),
    });
  }

  const quoteDraft = buildQuoteDraft({ dealAsk, base, band, policy });
  const quoteDigest = digest(quoteDraft);
  const sendProposal = {
    schema: "runx.quote_guard.send_proposal.v1",
    status: "proposed",
    gated: true,
    downstream_runner: "send-as",
    this_skill_sends: false,
    channel: "email",
    audience: base.counterparty.contact,
    subject: `Quote for ${base.product}`,
    quote_digest: quoteDigest,
    requires_human_approval: band.requires_approval === true,
  };
  const settlementCeiling = {
    schema: "runx.quote_guard.settlement_ceiling.v1",
    status: "proposed",
    gated: true,
    downstream_runner: "spend-refund",
    this_skill_settles_money: false,
    currency,
    amount_usd: roundMoney(Math.min(requestedNetUsd, band.max_total_contract_value_usd)),
    cap_basis: {
      policy_band: band.name,
      max_total_contract_value_usd: roundMoney(band.max_total_contract_value_usd),
      requested_net_usd: roundMoney(requestedNetUsd),
    },
  };

  return {
    schema: "runx.quote_guard.result.v1",
    status: "sealed",
    decision: {
      authorized: true,
      reason: "in_policy",
      policy_band: band.name,
      requires_approval: band.requires_approval === true,
    },
    compatibility: null,
    quote_draft: quoteDraft,
    send_proposal: sendProposal,
    settlement_ceiling: settlementCeiling,
    escalation: {
      required: false,
      reason_code: null,
    },
    observations: observations(base).concat([
      {
        type: "decision",
        authorized: true,
        reason: "in_policy",
        policy_band: band.name,
      },
      {
        type: "policy_band",
        name: band.name,
        max_discount_percent: roundPercent(band.max_discount_percent),
        max_total_contract_value_usd: roundMoney(band.max_total_contract_value_usd),
        requires_approval: band.requires_approval === true,
      },
      {
        type: "settlement_ceiling",
        amount_usd: settlementCeiling.amount_usd,
        currency: settlementCeiling.currency,
        cap_basis: settlementCeiling.cap_basis,
      },
      {
        type: "quote_digest",
        digest: quoteDigest,
      },
      {
        type: "proposal_status",
        send_proposal: "proposed_gated",
        this_skill_sends: false,
        this_skill_settles_money: false,
      },
    ]),
  };
}

function firstRefusal({ policy, product, currency, requestedNetUsd, requestedDiscount, margin }) {
  if (!Array.isArray(policy.authorized_products) || !policy.authorized_products.includes(product)) {
    return {
      reason_code: "product_not_authorized",
      message: "deal_ask.product is not listed in account_policy.authorized_products",
      details: { product, authorized_products: policy.authorized_products || [] },
    };
  }
  if (policy.currency && policy.currency !== currency) {
    return {
      reason_code: "currency_mismatch",
      message: "deal_ask.currency does not match account_policy.currency",
      details: { deal_currency: currency, policy_currency: policy.currency },
    };
  }
  if (requestedNetUsd <= 0 || requestedDiscount < 0) {
    return {
      reason_code: "invalid_pricing",
      message: "requested pricing must be positive and discount cannot be negative",
      details: { requested_net_usd: requestedNetUsd, requested_discount_percent: requestedDiscount },
    };
  }
  if (margin !== null && typeof policy.minimum_margin_percent === "number" && margin < policy.minimum_margin_percent) {
    return {
      reason_code: "margin_below_policy",
      message: "requested margin is below account_policy.minimum_margin_percent",
      details: {
        requested_margin_percent: roundPercent(margin),
        minimum_margin_percent: roundPercent(policy.minimum_margin_percent),
      },
    };
  }
  return null;
}

function refused(reasonCode, message, base, details = {}) {
  return {
    schema: "runx.quote_guard.result.v1",
    status: "refused",
    decision: {
      authorized: false,
      reason: reasonCode,
      policy_band: null,
    },
    quote_draft: null,
    send_proposal: null,
    settlement_ceiling: null,
    escalation: {
      required: true,
      lane: "human_pricing_approval",
      reason_code: reasonCode,
      message,
      details,
    },
    observations: observations(base).concat([
      {
        type: "decision",
        authorized: false,
        reason: reasonCode,
      },
      {
        type: "proposal_status",
        send_proposal: "not_emitted",
        settlement_ceiling: "not_emitted",
      },
      {
        type: "escalation_decision",
        required: true,
        reason_code: reasonCode,
        message,
        details,
      },
    ]),
  };
}

function escalated(reasonCode, message, baseObservations) {
  return {
    schema: "runx.quote_guard.result.v1",
    status: "escalated",
    decision: {
      authorized: false,
      reason: reasonCode,
      policy_band: null,
    },
    quote_draft: null,
    send_proposal: null,
    settlement_ceiling: null,
    escalation: {
      required: true,
      lane: "human_pricing_approval",
      reason_code: reasonCode,
      message,
    },
    observations: baseObservations.concat([
      {
        type: "escalation_decision",
        required: true,
        reason_code: reasonCode,
        message,
      },
    ]),
  };
}

function observations(base) {
  return [
    {
      type: "deal_ask",
      account_id: base.account_id,
      product: base.product,
      counterparty_name: base.counterparty.name,
      requested: base.requested,
    },
    {
      type: "prior_quote_evidence",
      records: base.prior_quote_evidence,
      count: base.prior_quote_evidence.length,
    },
  ];
}

function buildQuoteDraft({ dealAsk, base, band, policy }) {
  const validDays = Number.isFinite(dealAsk.quote_valid_days)
    ? Number(dealAsk.quote_valid_days)
    : Number(policy.default_quote_valid_days || 14);
  return {
    schema: "runx.quote_guard.quote_draft.v1",
    account_id: base.account_id,
    counterparty: base.counterparty,
    product: base.product,
    quantity: base.requested.quantity,
    term_months: base.requested.term_months,
    currency: base.requested.currency,
    list_price_usd: base.requested.list_price_usd,
    net_price_usd: base.requested.requested_net_usd,
    discount_percent: base.requested.requested_discount_percent,
    valid_days: validDays,
    policy_band: band.name,
    approval_required: band.requires_approval === true,
    line_items: [
      {
        product: base.product,
        quantity: base.requested.quantity,
        term_months: base.requested.term_months,
        list_price_usd: base.requested.list_price_usd,
        net_price_usd: base.requested.requested_net_usd,
      },
    ],
    evidence_refs: base.prior_quote_evidence.map((record) => record.quote_id),
  };
}

function selectApprovalBand(bands, requestedDiscount, requestedNetUsd) {
  return bands
    .filter((band) => requestedDiscount <= band.max_discount_percent && requestedNetUsd <= band.max_total_contract_value_usd)
    .sort((a, b) => {
      const discountDelta = a.max_discount_percent - b.max_discount_percent;
      if (discountDelta !== 0) return discountDelta;
      return a.max_total_contract_value_usd - b.max_total_contract_value_usd;
    })[0] || null;
}

function validatePolicy(policy) {
  if (!Array.isArray(policy.approval_bands) || policy.approval_bands.length === 0) {
    throw problem("missing_approval_bands", "account_policy.approval_bands must contain at least one band.");
  }
  for (const band of policy.approval_bands) {
    stringValue(band.name, "approval_bands[].name");
    percentNumber(band.max_discount_percent, "approval_bands[].max_discount_percent");
    positiveNumber(band.max_total_contract_value_usd, "approval_bands[].max_total_contract_value_usd");
  }
}

function normalizeCounterparty(counterparty) {
  const value = objectValue(counterparty, "deal_ask.counterparty");
  const name = stringValue(value.name, "deal_ask.counterparty.name");
  const contact = stringValue(value.contact, "deal_ask.counterparty.contact");
  if (name.toLowerCase() === "unknown" || contact.toLowerCase() === "unknown") {
    throw problem("ambiguous_counterparty", "counterparty name and contact must be specific.");
  }
  return { name, contact };
}

function normalizeHistoryRecord(record) {
  const value = objectValue(record, "quote_history[]");
  return {
    quote_id: stringValue(value.quote_id, "quote_history[].quote_id"),
    account_id: stringValue(value.account_id, "quote_history[].account_id"),
    product: stringValue(value.product || "unknown", "quote_history[].product"),
    total_contract_value_usd: positiveNumber(value.total_contract_value_usd, "quote_history[].total_contract_value_usd"),
    discount_percent: percentNumber(value.discount_percent, "quote_history[].discount_percent"),
    status: stringValue(value.status, "quote_history[].status"),
    created_at: stringValue(value.created_at, "quote_history[].created_at"),
  };
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw problem("invalid_object", `${name} must be an object.`);
  }
  return value;
}

function arrayValue(value, name) {
  if (!Array.isArray(value)) {
    throw problem("invalid_array", `${name} must be an array.`);
  }
  return value;
}

function stringValue(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw problem("invalid_string", `${name} must be a non-empty string.`);
  }
  return value.trim();
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw problem("invalid_number", `${name} must be a positive number.`);
  }
  return number;
}

function percentNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw problem("invalid_percent", `${name} must be between 0 and 100.`);
  }
  return number;
}

function maxOf(values, key) {
  return values.reduce((max, value) => Math.max(max, Number(value[key] || 0)), 0);
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function roundPercent(value) {
  return Math.round(Number(value) * 100) / 100;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function problem(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
