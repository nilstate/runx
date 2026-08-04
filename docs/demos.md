# Demo Gallery

These demos are runnable from this repository and produce signed receipts. Use the
standalone verifier at `tools/verify/verify.mjs` with the demo issuer key in
`tools/verify/runx-demo-jwks.json`.

`docs/demo-inventory.json` is the machine-checked source of truth for featured
demos, runnable previews, and fixture support.

```sh
export RUNX_RECEIPT_SIGN_KID=runx-demo-key
export RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64=QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=
export RUNX_RECEIPT_SIGN_ISSUER_TYPE=hosted
```

## Shipped Demos

| Demo | Proof | Run | Gate |
| --- | --- | --- | --- |
| `examples/hello-world` | Native CLI top-level skill and harness baseline. | `runx harness examples/hello-world` | harness |
| `skills/business-ops` | Launch routing stops sends and spend at their gates, requires provider evidence, persists a route, and proves idempotent replay. | `runx harness skills/business-ops` | harness |
| `skills/data-store` | A provider-agnostic data operation appends and reads durable SQLite state through a governed adapter envelope. | `runx harness skills/data-store/fixtures/append-read-sqlite-event.yaml` | harness |
| `examples/github-mcp-hero` | GitHub MCP repo read succeeds, out-of-scope write is refused, and the denial receipt verifies offline. | `sh examples/github-mcp-hero/run.sh` | harness |
| `examples/openapi-graph` | An OpenAPI-described operation is executed through the governed external-adapter lane and sealed. | `sh examples/openapi-graph/run.sh` | harness |
| `skills/nws-weather-forecast` | The official NWS skill executes through native `http.read` and seals stable provider metadata. | `runx harness skills/nws-weather-forecast/fixtures/nws-forecast-washington-monument.yaml` | live external |
| `examples/governed-spend/skills/overspend-refused` | A spend request over authority is refused and sealed as a deterministic local receipt. | `runx harness examples/governed-spend/skills/overspend-refused` | harness |
| `examples/governed-spend/x402.sh` | x402 receipt path over the Runx signer/facilitator seam, deterministic by default and live when compatible operator endpoints are exported; settlement and refusal receipts verify offline. | `sh examples/governed-spend/x402.sh` | `pnpm demos:check` |
| `examples/governed-spend/stripe-spt.sh` | Stripe SPT test-mode path, deterministic by default and live when operator test credentials are exported; settlement and refusal receipts verify offline. | `sh examples/governed-spend/stripe-spt.sh` | `pnpm demos:check` |
| `examples/loop-orchestration` | A bounded outer loop submits governed runx turns, prints receipt ids and next-turn reasons, demonstrates `context_skills`, and includes a refusal path. | `sh examples/loop-orchestration/run.sh` | harness |

## Payment Demo Gate

For the deterministic payment demo gate:

```sh
pnpm demos:check
```

This runs the safe payment demo paths (`payments-demo.mjs`, x402 mock, and Stripe
SPT mock) and verifies every emitted receipt with the standalone verifier. It is
the featured demo command for `examples/governed-spend` because it has no funded
wallet, hosted account, provider-key, or upstream checkout dependency.

What this proves:

- Runx admits bounded payment authority and refuses overspend before a rail call.
- Settlement and refusal receipt artifacts are signed and verify offline.

What this does not prove:

- A real x402 payment settled on Base Sepolia or another public testnet.
- CDP or another hosted facilitator accepted a live settlement.
- A real wallet/provider key was usable.

The broader zero-funded dogfood lane also preflights upstream x402, x402-rs, CDP,
and Stripe SPT live readiness. Treat that lane as developer verification, not as
a featured demo: it may report missing upstream checkouts, credentials, or funded
testnet wallets on a no-account machine.

For a real x402 protocol conformance run, use
`node scripts/x402-upstream-conformance.mjs --check` and then
`node scripts/x402-upstream-conformance.mjs --run` from a clean upstream checkout
with dedicated funded testnet wallets. That proves the official HTTP 402 flow.
Run `examples/governed-spend/x402.sh` separately when you need Runx receipt proof
for a compatible signer/facilitator seam.

For independent implementation coverage, use `pnpm x402:interop` against
`x402-rs`. CDP is tracked as a hosted-facilitator profile via
`node scripts/x402-interop.mjs --target cdp --check`.

## Verify A Receipt

The verifier is independent of runx runtime code. It recomputes the canonical
receipt body hash, checks the content-addressed receipt id, verifies the Ed25519
signature, and can walk receipt ancestry from top-level receipt-store artifacts.

```sh
node tools/verify/verify.mjs /path/to/receipt.json \
  --jwks tools/verify/runx-demo-jwks.json

node tools/verify/verify.mjs /path/to/graph-root-receipt.json \
  --jwks tools/verify/runx-demo-jwks.json \
  --walk-ancestry \
  --receipt-dir /path/to/receipt-store
```

All demos call `tools/verify/verify.mjs` directly; there is no second verifier
entrypoint to drift from the canonical implementation.
