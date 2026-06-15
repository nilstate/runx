#!/usr/bin/env node

import { runAdapter } from "../../../../scripts/lib/external-adapter.mjs";

const DEFAULT_STRIPE_EXECUTOR_MODULE =
  "../../../../../cloud/packages/stripe-executor/dist/index.js";

runAdapter(async ({ inputs }) => {
  const challenge = record(inputs.payment_challenge, "payment_challenge");
  const paymentAdmission = normalizedPaymentAdmission(
    record(inputs.payment_admission, "payment_admission"),
  );
  const idempotency = record(inputs.idempotency, "idempotency");
  const rail = requiredString(challenge, "rail");
  if (rail !== "stripe-spt") {
    throw new Error(`stripe-spt adapter expected payment_challenge.rail stripe-spt, got ${rail}`);
  }

  const issuance = stripeIssuanceFromInputs({
    challenge,
    paymentAdmission,
    idempotency,
  });
  assertAdmissionMatchesChallenge(paymentAdmission, {
    amountMinor: issuance.amount_minor,
    currency: issuance.currency.toUpperCase(),
    counterparty: issuance.counterparty,
    rail: issuance.rail,
  });

  const executorModule = await resolveStripeExecutorModule();
  const executor = executorModule.createStripeSptExecutor({
    restrictedKey: restrictedStripeKey(),
    api_base_url: optionalString(process.env.RUNX_STRIPE_API_BASE_URL),
    fetch: process.env.RUNX_STRIPE_SPT_MOCK === "1" ? mockStripeFetch(issuance) : undefined,
  });
  const charge = await executor.chargeScopedPayment({
    issuance,
    test_payment_method_id: optionalString(inputs.test_payment_method_id),
  });
  const providerEventRef = optionalString(inputs.provider_event_ref) ?? charge.charge_id;

  return {
    rail_result: {
      status: "fulfilled",
      rail,
      amount_minor: charge.amount_minor,
      currency: charge.currency.toUpperCase(),
      counterparty: issuance.counterparty,
      payment_intent_id: charge.payment_intent_id,
      charge_id: charge.charge_id,
      event_id: providerEventRef,
      shared_payment_token_id: charge.shared_payment_token_id,
      money_movement_id: charge.money_movement_id,
      admission_token_digest: charge.admission_token_digest,
      usage_limit_amount_minor: charge.amount_minor,
      usage_limit_currency: charge.currency.toUpperCase(),
    },
    rail_proof: {
      proof_ref: charge.charge_id ?? charge.payment_intent_id,
      provider_event_ref: providerEventRef,
      idempotency_key: issuance.idempotency_key,
      payment_admission_id: paymentAdmission.payment_admission_id,
      money_movement_id: charge.money_movement_id,
      kernel_token_digest: paymentAdmission.kernel_token_digest,
    },
    credential_envelope: {
      form: "stripe_spt_scoped_token",
      credential_ref: charge.shared_payment_token_id,
      usage_limit_amount_minor: charge.amount_minor,
      usage_limit_currency: charge.currency.toUpperCase(),
      admission_token_digest: charge.admission_token_digest,
    },
    redactions: ["rail_session_material"],
    recovery_hint: {
      status: "sealed",
      rail,
      proof_ref: charge.charge_id ?? charge.payment_intent_id,
    },
    settlement_proof: {
      payment_admission_id: paymentAdmission.payment_admission_id,
      money_movement_id: charge.money_movement_id,
      kernel_token_digest: paymentAdmission.kernel_token_digest,
      proof_locator: providerEventRef ?? charge.payment_intent_id,
      proof_status: "fulfilled",
    },
    kernel_token: {
      digest: paymentAdmission.kernel_token_digest,
    },
  };
});

async function resolveStripeExecutorModule() {
  if (process.env.RUNX_STRIPE_SPT_MOCK === "1" && !process.env.RUNX_STRIPE_SPT_EXECUTOR_MODULE) {
    return mockStripeExecutorModule();
  }
  return await importStripeExecutor();
}

function stripeIssuanceFromInputs({ challenge, paymentAdmission, idempotency }) {
  return {
    rail: "stripe-spt",
    money_movement_id: paymentAdmission.money_movement_id,
    admission_token_digest: paymentAdmission.kernel_token_digest,
    amount_minor: requiredPositiveInteger(challenge, "amount_minor"),
    currency: requiredString(challenge, "currency").toUpperCase(),
    counterparty: requiredString(challenge, "counterparty"),
    idempotency_key: requiredString(idempotency, "key"),
  };
}

function normalizedPaymentAdmission(value) {
  const token = optionalRecord(value.token);
  return {
    payment_admission_id: firstString(
      [value.payment_admission_id, value.token_digest, token?.token_digest],
      "payment_admission.payment_admission_id",
    ),
    money_movement_id: firstString(
      [value.money_movement_id, token?.money_movement_id],
      "payment_admission.money_movement_id",
    ),
    kernel_token_digest: firstString(
      [value.kernel_token_digest, value.token_digest, token?.token_digest],
      "payment_admission.kernel_token_digest",
    ),
    token: token
      ? {
          rail: optionalString(token.rail),
          amount_minor: optionalInteger(token.amount_minor),
          currency: optionalString(token.currency)?.toUpperCase(),
          counterparty: optionalString(token.counterparty),
        }
      : undefined,
  };
}

function assertAdmissionMatchesChallenge(admission, challenge) {
  if (admission.token?.rail && admission.token.rail !== challenge.rail) {
    throw new Error("payment admission rail does not match payment challenge rail");
  }
  if (admission.token?.amount_minor !== undefined && admission.token.amount_minor !== challenge.amountMinor) {
    throw new Error("payment admission amount does not match payment challenge amount");
  }
  if (admission.token?.currency && admission.token.currency !== challenge.currency) {
    throw new Error("payment admission currency does not match payment challenge currency");
  }
  if (admission.token?.counterparty && admission.token.counterparty !== challenge.counterparty) {
    throw new Error("payment admission counterparty does not match payment challenge counterparty");
  }
}

async function importStripeExecutor() {
  const configured = optionalString(process.env.RUNX_STRIPE_SPT_EXECUTOR_MODULE);
  const moduleUrl = new URL(configured ?? DEFAULT_STRIPE_EXECUTOR_MODULE, import.meta.url);
  const executorModule = await import(moduleUrl.href);
  if (typeof executorModule.createStripeSptExecutor !== "function") {
    throw new Error("Stripe executor module must export createStripeSptExecutor");
  }
  return executorModule;
}

function restrictedStripeKey() {
  const key = optionalString(process.env.RUNX_STRIPE_SPT_RESTRICTED_KEY);
  if (key) {
    return key;
  }
  if (process.env.RUNX_STRIPE_SPT_MOCK === "1") {
    return "rk_test_runx_mock";
  }
  throw new Error("RUNX_STRIPE_SPT_RESTRICTED_KEY is required for Stripe SPT fulfillment");
}

function mockStripeFetch(issuance) {
  return async (url, init) => {
    const target = String(url);
    const id = safeStripeSuffix(issuance.money_movement_id);
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (target.endsWith("/v1/test_helpers/shared_payment/granted_tokens")) {
      assertUsageLimitBody(body, issuance);
      return jsonResponse({ id: `spt_test_${id}` });
    }
    if (target.endsWith("/v1/payment_intents")) {
      assertUsageLimitBody(body, issuance);
      return jsonResponse({ id: `pi_test_${id}`, latest_charge: `ch_test_${id}` });
    }
    return jsonResponse({ error: { message: `unexpected Stripe endpoint ${target}` } }, 404);
  };
}

function mockStripeExecutorModule() {
  return {
    createStripeSptExecutor() {
      return {
        async chargeScopedPayment({ issuance }) {
          assertMockIssuance(issuance);
          const id = safeStripeSuffix(issuance.money_movement_id);
          return {
            amount_minor: issuance.amount_minor,
            currency: issuance.currency.toUpperCase(),
            payment_intent_id: `pi_test_${id}`,
            charge_id: `ch_test_${id}`,
            shared_payment_token_id: `spt_test_${id}`,
            money_movement_id: issuance.money_movement_id,
            admission_token_digest: issuance.admission_token_digest,
          };
        },
      };
    },
  };
}

function assertMockIssuance(issuance) {
  if (!issuance || typeof issuance !== "object") {
    throw new Error("Stripe SPT mock expected an issuance object");
  }
  requiredPositiveInteger(issuance, "amount_minor");
  requiredString(issuance, "currency");
  requiredString(issuance, "money_movement_id");
  requiredString(issuance, "admission_token_digest");
}

function assertUsageLimitBody(body, issuance) {
  const amount = body.get("usage_limits[max_amount]") ?? body.get("amount");
  const currency = body.get("usage_limits[currency]") ?? body.get("currency");
  if (amount !== String(issuance.amount_minor)) {
    throw new Error("Stripe SPT mock observed a request outside the admitted amount");
  }
  if (currency !== issuance.currency.toLowerCase()) {
    throw new Error("Stripe SPT mock observed a request outside the admitted currency");
  }
  if (body.get("metadata[admission_token_digest]") !== issuance.admission_token_digest) {
    throw new Error("Stripe SPT mock observed a request missing the admission digest");
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function safeStripeSuffix(value) {
  return value.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 32) || "runx";
}

function record(value, label) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  throw new Error(`${label} must be an object`);
}

function optionalRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function requiredString(source, field) {
  const value = optionalString(source[field]);
  if (!value) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function firstString(values, label) {
  for (const value of values) {
    const text = optionalString(value);
    if (text) {
      return text;
    }
  }
  throw new Error(`${label} is required`);
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function requiredPositiveInteger(source, field) {
  const value = optionalInteger(source[field]);
  if (value !== undefined && value > 0) {
    return value;
  }
  throw new Error(`${field} must be a positive safe integer`);
}
