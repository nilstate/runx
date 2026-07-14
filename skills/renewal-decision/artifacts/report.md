# renewal-decision delivery report

## Package

- Public URL: https://runx.ai/x/dh0h/renewal-decision@sha-23e7a258c30a
- Registry package: `dh0h/renewal-decision@sha-23e7a258c30a`
- PR: https://github.com/runxhq/runx/pull/278
- Source: https://github.com/dh0h/runx/tree/codex/renewal-decision-110/skills/renewal-decision

## Verification

- `runx-cli 0.6.19` satisfies the `0.6.14+` requirement.
- Local harness passed with exactly two cases: one sealed renew case and one `needs_agent` stop case; its receipt verifies in production signature mode.
- Hosted registry publish gate passed and published version `sha-23e7a258c30a`.
- Registry read and install both resolved the package with runner `decide`.
- Published-package dogfood run sealed production-signed receipt `runx:receipt:sha256:94d044d29550ccf178841133f5ad6f408e59fb1f7855754af066ca22d4a68639`.
- Plain receipt verification passed with the standard production verifier: `signature_mode: production`, 4-receipt tree, no findings.
- Verification public key: `RUNX_RECEIPT_VERIFY_KID=dh0h-frantic-receipt-2026-07-14-e88f2687`, `RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64=UojZI9lCxtz5KRlZmm1z2iNazzUIIct+9oZ0Ew8Brz4=`.

## Domain Evidence

- Happy path matched `vendor:acme-observability` to `contract:acme-observability:2026`.
- Usage was 3695 units against a 3000-unit minimum.
- Renewal offer was USD 112000 against a USD 100000 contract and 15% cap, a 12% increase.
- The renew output carried only a bounded `runx.attenuation_request.v1` ceiling as data.
- The ceiling scopes were `spend.reserve`, `spend.settle`, and `receipt.seal`; no authority was minted in this skill.
- Human approval is required before the downstream spend/refund accepting runner consumes the ceiling.
- The stop fixture covers low usage plus over-cap offer and pauses at `needs_agent` with no ceiling, vendor notice, mint, or append.

## Data Store

- The decision packet carries `registry:runx/data-store@0.1.2` as the handoff package reference.
- The graph reads `read_projection` and writes `append_event` for `vendor_renewals` keyed by `vendor_id`.
- Dogfood append used `expected_version: 0`, idempotency key `renewal-decision:vendor:acme-observability:2026-08:renew`, and committed version `1`.
- The hosted harness uses a pinned fixture `store_id` and bundled data-store provider adapter catalog for deterministic execution.
