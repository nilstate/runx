# governed-spend spend (demo)

A prompt-injected agent tries to overspend; runx refuses before any rail is
touched, identically across x402, MPP, and Stripe, and signs a receipt for every
outcome. The agent never holds the authority, so hijacking it changes nothing.

## Run it

```bash
./run.sh
```

No keys, no signup, no network. Needs the `runx` binary (a build under
`crates/target/`, `runx` on `PATH`, or `RUNX_BIN=/path/to/runx`) and `python3`.

The script prints three steps:

1. A bounded authority pays on `x402`, `mpp`, and `stripe`, each sealing a receipt.
2. The reserved child authority is capped at 100 minor; an injected agent tries to
   fulfill 125; runx blocks at the rail gate before any provider call.
3. A sealed refusal receipt: `disposition: refused`, `reason_code: cap_exceeded`,
   `rail_call_performed: false`.

## Over MCP

```bash
./mcp.sh
```

Serves `x402-pay`, `mpp-pay`, `stripe-pay`, and `overspend-refused` as MCP tools.
An agent calls a skill and gets the sealed receipt id, or the refusal, in one
round-trip.

## Recorded payments demo

```bash
node ../../scripts/payments-demo.mjs --record --receipt-dir /tmp/runx-payments-demo
node ../../tools/verify/verify.mjs /tmp/runx-payments-demo/payments-demo-paid.receipt.json
node ../../tools/verify/verify.mjs /tmp/runx-payments-demo/payments-demo-refusal.receipt.json
```

With `ANTHROPIC_API_KEY` and `RUNX_X402_SIGNER` present, the script records an
operator-keyed testnet transcript. Without those keys it writes a deterministic
mock transcript. In both modes the offline receipts are real signed artifacts:
one scoped x402 spend, then one over-run-cap refusal before money moves.

## x402 receipt demo

```bash
./x402.sh
```

Without x402 environment variables this writes a deterministic mock transcript.
With a Runx-compatible operator signer and facilitator exported in the calling
shell, it performs a real testnet settlement through the Runx signer/facilitator
seam and verifies both receipts offline:

```bash
export RUNX_X402_DEMO_MODE=live
export RUNX_X402_FACILITATOR=https://...
export RUNX_X402_SIGNER=https://...
export RUNX_X402_CHAIN_ID=84532
export RUNX_X402_TOKEN_CONTRACT=0x...
export RUNX_X402_VERIFYING_CONTRACT=0x...
export RUNX_X402_FROM=0x...
export RUNX_X402_PAY_TO=0x...
./x402.sh
```

The signer endpoint receives the runx-bound EIP-712 template and returns only a
signature. runx never stores the wallet key.

This script is not, by itself, an upstream x402 protocol conformance test. It
proves the Runx receipt, authority, signer, and settlement-recording seam. Use the
upstream conformance process below to prove the standard HTTP 402 flow.

## Zero-funded x402 dogfood

Use this when you want to exercise everything that is honest to exercise without
a funded testnet wallet:

```bash
pnpm x402:dogfood:local
```

The command runs the deterministic Runx payment demos and verifies the emitted
receipts. It also prints preflight reports for the upstream x402, x402-rs, CDP,
and Stripe SPT lanes so the live requirements are visible. Missing funded wallet
env or provider credentials are reported live-lane blockers, not local dogfood
failures.

This is the correct no-account loop. It proves authority, refusal, receipt
signing, offline verification, and that the live lanes are wired. It does not
claim public-chain settlement. For that, use the upstream conformance or x402-rs
interop process with dedicated funded testnet wallets.

## Live rail readiness matrix

Use the local dogfood lane first. It does not need funded wallets, hosted
accounts, provider keys, `.env` files, or generated credentials:

```bash
pnpm x402:dogfood:local
```

The live lanes are opt-in and require operator-owned external resources:

For no-secret preflights, a zero exit means the readiness report was produced.
Inspect `can_run`, `missing_env`, `invalid_env`, and `required_external` before
claiming a live lane is runnable.

| Lane | No-secret preflight | External funding/keys needed for live | Live command |
| --- | --- | --- | --- |
| Upstream x402 HTTP 402 conformance | `node scripts/x402-upstream-conformance.mjs --check` | Clean `x402-foundation/x402` checkout; dedicated funded EVM testnet wallets for `SERVER_EVM_ADDRESS`, `CLIENT_EVM_PRIVATE_KEY`, and `FACILITATOR_EVM_PRIVATE_KEY`; SVM address/key variables are also required by the current upstream runner before its EVM-only filter applies. | `node scripts/x402-upstream-conformance.mjs --run` |
| x402-rs interop | `node scripts/x402-interop.mjs --target x402-rs --check` | Clean `x402-rs/x402-rs` checkout; Base Sepolia RPC URL; dedicated funded Base Sepolia buyer/facilitator private keys; Solana Devnet RPC URL and buyer/facilitator keys because the compliance harness validates them at module load. | `node scripts/x402-interop.mjs --target x402-rs --run` |
| CDP hosted facilitator | `node scripts/x402-interop.mjs --target cdp --check` | CDP API credentials for hosted-facilitator authentication and a dedicated funded Base Sepolia payer wallet. The repo does not yet define a CDP live env contract, so do not invent or commit CDP env files. | Planned only |
| Runx x402 receipt seam | `RUNX_X402_DEMO_MODE=mock sh examples/governed-spend/x402.sh` | Compatible facilitator URL, compatible external signer URL backed by a dedicated funded Base Sepolia operator wallet, chain/token/verifying-contract addresses, payer address, and pay-to address. runx receives only a signer endpoint response, not a wallet key. | `RUNX_X402_DEMO_MODE=live sh examples/governed-spend/x402.sh` |
| Stripe SPT | `node scripts/stripe-spt-charge.mjs --check` | Stripe test-mode key via `STRIPE_SECRET_KEY` or `STRIPE_TEST_KEY`, plus `STRIPE_WEBHOOK_SECRET`. No funded wallet is required; live-mode Stripe keys are refused. | `RUNX_STRIPE_DEMO_MODE=live sh examples/governed-spend/stripe-spt.sh` |

Keep artifact directories outside the repo or under ignored temp paths, for
example `/tmp/runx-x402-upstream-conformance`, `/tmp/runx-x402-rs-interop`,
`RUNX_X402_RECEIPT_DIR`, and `RUNX_STRIPE_RECEIPT_DIR`. Never commit secrets,
private keys, generated wallets, `.env` files, upstream logs containing secrets,
or receipt directories from live runs.

## Upstream x402 conformance process

Use this when you need to prove the x402 shape itself, not a runx-authored mock.
The source of truth is the upstream standard repository:

```bash
git clone https://github.com/x402-foundation/x402 /tmp/x402-upstream
cd /tmp/x402-upstream
git rev-parse HEAD
```

Install the upstream e2e runner from the official checkout:

```bash
cd /tmp/x402-upstream/e2e
pnpm install:all
```

From the Runx OSS checkout, preflight the exact upstream scenario:

```bash
pnpm x402:conformance
```

The preflight records the upstream commit SHA and prints missing environment
variables without reading or writing secrets. The minimal official scenario is
the TypeScript facilitator + Express resource server + fetch client, filtered to
Base Sepolia EVM, exact settlement, and `/exact/evm/eip3009`:

```bash
pnpm --dir /tmp/x402-upstream/e2e test \
  --testnet \
  --families=evm \
  --versions=2 \
  --schemes=exact \
  --clients=fetch \
  --servers=express \
  --facilitators=typescript \
  --endpoints=/exact/evm/eip3009 \
  --min \
  --output-json=/tmp/runx-x402-upstream-conformance/x402-upstream-e2e.json \
  --log=/tmp/runx-x402-upstream-conformance/x402-upstream-e2e.log
```

Run it through the Runx wrapper when dedicated funded test wallets are ready:

```bash
export X402_UPSTREAM_DIR=/tmp/x402-upstream
export RUNX_X402_CONFORMANCE_ARTIFACT_DIR=/tmp/runx-x402-upstream-conformance
export SERVER_EVM_ADDRESS=0x...
export CLIENT_EVM_PRIVATE_KEY=0x...
export FACILITATOR_EVM_PRIVATE_KEY=0x...
export SERVER_SVM_ADDRESS=...
export CLIENT_SVM_PRIVATE_KEY=...
export FACILITATOR_SVM_PRIVATE_KEY=...
node scripts/x402-upstream-conformance.mjs --run
```

The current upstream runner checks the SVM variables before applying the EVM-only
filter, so they are required even for this EVM-only scenario. Use dedicated
testnet wallets only; the upstream e2e runner may move funds between configured
wallets as part of normal setup/cleanup.

If you only need the narrower upstream SDK-level Base Sepolia settle check, use
the upstream EVM package integration test instead:

```bash
cd /tmp/x402-upstream/typescript/packages/mechanisms/evm
export CLIENT_PRIVATE_KEY=0x...
export FACILITATOR_PRIVATE_KEY=0x...
pnpm exec vitest run --config vitest.integration.config.ts test/integrations/exact-evm.test.ts
```

That is useful for rail mechanics, but it is not the full HTTP 402
client/server/facilitator conformance run.

## x402-rs interop process

Use this when you need an independent implementation check after the canonical
upstream conformance pass. `x402-rs` is not the source of truth for the standard,
but its protocol-compliance harness is a strong adversarial target because it can
run a TypeScript client + TypeScript server against a Rust facilitator.

```bash
git clone https://github.com/x402-rs/x402-rs /tmp/x402-rs
cd /tmp/x402-rs
git rev-parse HEAD
```

From the Runx OSS checkout, preflight the default x402-rs lane:

```bash
pnpm x402:interop
```

The default lane is:

```bash
pnpm --dir /tmp/x402-rs/protocol-compliance install --frozen-lockfile
cargo build --manifest-path /tmp/x402-rs/Cargo.toml --package x402-facilitator
pnpm --dir /tmp/x402-rs/protocol-compliance exec vitest run \
  src/tests/v2-eip155-exact-ts-ts-rs.test.ts \
  --reporter=verbose
```

Run it when dedicated funded testnet wallets are ready:

```bash
export X402_RS_DIR=/tmp/x402-rs
export RUNX_X402_INTEROP_ARTIFACT_DIR=/tmp/runx-x402-rs-interop
export BASE_SEPOLIA_RPC_URL=https://...
export BASE_SEPOLIA_BUYER_PRIVATE_KEY=0x...
export BASE_SEPOLIA_FACILITATOR_PRIVATE_KEY=0x...
export SOLANA_DEVNET_RPC_URL=https://...
export SOLANA_DEVNET_BUYER_PRIVATE_KEY=...
export SOLANA_DEVNET_FACILITATOR_PRIVATE_KEY=...
node scripts/x402-interop.mjs --target x402-rs --run
```

The current x402-rs compliance harness validates Solana environment variables at
module load even for this EVM-only test selection, so the Solana variables are
required. The accepted result is a successful v2 EIP-155 exact test where the
TypeScript client and server interoperate with the Rust facilitator.

## CDP hosted-facilitator plan

Use CDP after the local independent-implementation lane is green. CDP is not a
repository checkout; it is a hosted facilitator target. Preflight the plan:

```bash
node scripts/x402-interop.mjs --target cdp --check
```

The planned CDP lane should reuse the same Base Sepolia v2 exact flow, swapping
only the facilitator URL and authentication:

- Facilitator URL: `https://api.cdp.coinbase.com/platform/v2/x402`
- Signup-free testnet fallback: `https://x402.org/facilitator`
- Network: `eip155:84532` (Base Sepolia)
- Scheme: `exact`
- Token path: USDC / EIP-3009

Do not build a Runx-specific shim for CDP. The CDP lane is accepted only when the
standard HTTP 402 request/response flow succeeds through the hosted facilitator,
with the same receipt verification run separately through `./x402.sh` if Runx
receipt proof is also required.

Rules for a clean conformance run:

1. Do not patch or copy upstream protocol code into runx.
2. Record the upstream commit SHA beside the run output.
3. If an upstream example needs configuration, set environment variables only;
   do not commit secrets, private keys, generated wallets, or `.env` files.
4. Do not use the upstream `mock-facilitator` as settlement proof. It is a
   startup fallback and intentionally errors if `/verify` or `/settle` are called.
5. If you also need Runx receipt proof for the same rail, run `./x402.sh` with
   `RUNX_X402_DEMO_MODE=live` against a compatible signer/facilitator seam after
   the upstream conformance run succeeds.

The run is accepted only when:

- `node scripts/x402-upstream-conformance.mjs --run` succeeds from a clean
  upstream checkout at a recorded commit.
- The upstream output JSON records a successful TypeScript facilitator + Express
  server + fetch client scenario for `/exact/evm/eip3009`.
- If `./x402.sh` is also run, it reports `mode: live` and `operator_keyed: true`,
  and the settlement has a non-mock `tx_hash` / rail reference.
- Both `x402-settlement.receipt.json` and `x402-refusal.receipt.json` verify with
  `node tools/verify/verify.mjs` when the Runx receipt demo is run.

If any of those fail, call it a local mock or conformance failure, not a real x402
test.

## Stripe SPT test-mode demo

```bash
./stripe-spt.sh
```

Without Stripe environment variables this writes a deterministic mock transcript.
Check live-readiness without calling Stripe or printing secret values:

```bash
node scripts/stripe-spt-charge.mjs --check
```

The check exits 0 when it emits a report. Without Stripe test credentials the
report intentionally says `can_run: false` and names the missing env; that is a
live-readiness blocker, not a local dogfood failure.

With Stripe test-mode credentials exported in the calling shell, it performs a
real Stripe SPT test-mode charge and verifies both receipts offline:

```bash
export STRIPE_SECRET_KEY=sk_test_...
export STRIPE_WEBHOOK_SECRET=whsec_...
export RUNX_STRIPE_DEMO_MODE=live
./stripe-spt.sh
```

`STRIPE_TEST_KEY` is still accepted for older local setups. Live-mode keys are
refused; the script accepts only `sk_test_` or `rk_test_` keys and never writes
Stripe credentials to the receipt directory. Live mode generates a fresh Stripe
idempotency key for each run unless `RUNX_STRIPE_IDEMPOTENCY_KEY` is set.

## Tweak it

In [`skills/overspend-refused/X.yaml`](skills/overspend-refused/X.yaml), raise the
reserved child authority's `max_per_call_units` from `100` to `125` and re-run: the
same agent now fulfills, because the spend is within its authority.

## What is real

The kernel, the quote/reserve/fulfill graph, the fail-closed authority subset proof,
the authority admission that refuses before any rail, and signed receipts are real and ship today. The
rails run through deterministic test supervisors by default. The optional x402 and
Stripe SPT scripts can call test networks/providers when operator-provided
credentials are present. The refusal needs no rail, which is the point.
