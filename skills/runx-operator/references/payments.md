# Payments Reference

Use this reference for funding, payouts, refunds, target changes, chargebacks,
settlement health, and payment reconciliation.

## Rule

Money state changes only after rail proof becomes a receipt/effect. UI state,
provider optimism, local API success, or agent narration is not settlement.

## Common Lanes

- `payment.quote`: read-only or proposal; no approval.
- `payment.fund`: money movement; approval or payer signature required.
- `payment.payout`: money movement; approval required.
- `payment.refund`: money movement; approval required.
- `payment.target_update`: rail configuration; approval required.
- `payment.reconcile`: read-only unless it creates corrections.
- `payment.dispute_response`: customer/provider communication; approval
  depends on whether it submits externally.

## x402

An x402 requirement is exact. The payer must satisfy the quoted network, asset,
amount, pay-to address, and token domain. Do not treat USDC as a cross-network
balance.

For EVM networks, the same address can receive on multiple chains, but balances
are separate. Base, Arbitrum, Polygon, and Ethereum require separate
reconciliation and separate gas planning. Solana is a different rail family.

## Stripe

Treat Stripe/card flows as a separate readiness track. A healthy x402 rail does
not imply Stripe webhook, Connect, payout, refund, or chargeback readiness.

## Operator Packet Requirements

For each payment proposal include:

- payer/payee refs, redacted when necessary;
- amount and currency;
- rail and network;
- quote or settlement refs;
- expiry or idempotency key;
- approval requirement;
- expected receipt/effect;
- reconciliation readback.

## Stop Conditions

- Missing amount, payee, rail, quote, approval, or idempotency key.
- Requested manual funded/paid/refunded marking without receipt-backed proof.
- Network mismatch between quote and payer asset.
- Target update requested without explicit operator approval.
- Refund or payout amount not tied to the original settlement/claim policy.
