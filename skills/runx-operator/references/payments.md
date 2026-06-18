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

## Funding a wallet (fiat onto a network)

Bringing new money in is a human step. The CDP SDK and the x402 facilitator only
move USDC that is **already onchain** (gasless EIP-3009 between wallets whose keys
we hold; the smart-account float is sponsored by the CDP paymaster, a plain EOA is
not). They cannot pull an exchange or bank balance, and CDP Onramp is not
server-automatable (the owner must complete a hosted KYC + payment flow). An
operator requests a human top-up; it never auto-funds from fiat.

**Network trap (this has cost real time more than once):** the retail Coinbase
send does not reliably offer the network you want. For USDC it has shown an
**Ethereum-only** withdrawal with **no Base option**, regardless of Coinbase's
generic "assets on multiple networks" help docs. Never assume the exchange can
send to Base. Verify the live send flow first; reach Base through a Base-native
route (the Base app, or a bridge), not a direct exchange withdrawal. A receiving
address needs no ETH/gas to receive USDC.

Getting USDC onto Base when the exchange is ETH-only has one proven route: the
human sends USDC on **Ethereum** from the exchange, then **CCTP** (Circle's native
USDC burn-and-mint) carries it to Base. The operator burns the USDC on Ethereum
(approve, then depositForBurn on Circle's TokenMessenger), Circle attests the burn
once the source chain finalizes, and native USDC mints on Base. A **Standard**
transfer waits Ethereum finality (about 13 to 19 minutes) and is free; a **fast**
transfer settles in seconds for a small fee. Contract addresses are identical on
every EVM chain and the domain ids are fixed (Ethereum 0, Base 6); read the exact
addresses and the attestation endpoint from developers.circle.com, never from
memory. Two properties matter when operating it. A standing CCTP relayer
auto-submits the destination mint for Standard transfers, so the USDC usually
arrives on Base without the operator minting at all. And the Ethereum burn is the
only irreversible step, with attestations that never expire, so a pending or
failed mint is always recoverable by re-submitting the saved attestation. If the
operator self-mints, the caller needs gas on Base (a sponsored smart-account
works, a zero-gas EOA does not). The Coinbase **Base app** is receive-only here
(Deposit/Receive QR, no in-app Buy), so it is not a funding path by itself; a fiat
on-ramp that delivers USDC straight to a Base address also works but requires a
production on-ramp application.

Once USDC is on the target network in a wallet we hold keys for, every later move
(top-up, payout, sweep, round-trip) is free and gasless via the facilitator, with
no further human step.

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
- Payout requested for a claim that is not delivered and accepted at its policy
  bar, or for a payee with no payout identity on file.
