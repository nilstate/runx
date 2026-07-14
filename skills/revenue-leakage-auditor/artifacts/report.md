# revenue-leakage-auditor delivery report

## Package

- Public URL: https://runx.ai/x/dh0h/revenue-leakage-auditor@sha-8534d7161607
- Registry package: `dh0h/revenue-leakage-auditor@sha-8534d7161607`
- PR: https://github.com/runxhq/runx/pull/279
- Source: https://github.com/dh0h/runx/tree/codex/revenue-leakage-auditor-108/skills/revenue-leakage-auditor

## Verification

- `runx-cli 0.6.19` satisfies the `0.6.14+` requirement.
- Local harness passed with exactly two cases: one sealed under-billing case and one `needs_agent` stop case; its receipt verifies in production signature mode.
- The hosted registry publish gate passed and published version `sha-8534d7161607`.
- Registry read and clean install both resolved the package with runner `audit`.
- Published-package dogfood run sealed production-signed receipt `runx:receipt:sha256:518ed4ae4d885165101b57d2185361b3263bd05fa59c058c5abc75c12797e004`.
- The acceptance-form command `runx verify --receipt <receipt.json> --json` passed for the post-publish dogfood receipt with a valid digest, valid content address, `signature.mode: production`, and no findings; it used no verification bypass flag.
- A separate receipt-tree verification also passed for the complete 4-receipt lineage with `signature_mode: production` and no findings.
- Verification public key: `RUNX_RECEIPT_VERIFY_KID=dh0h-frantic-receipt-2026-07-14-e88f2687`, `RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64=UojZI9lCxtz5KRlZmm1z2iNazzUIIct+9oZ0Ew8Brz4=`.

## Domain Evidence

- Happy path reviewed `account:atlas-team` for period `2026-06`.
- Usage evidence ref is `usage:account:atlas-team:2026-06`.
- Billing evidence ref is `billing:account:atlas-team:2026-06`.
- Usage was USD 15000 and billing was USD 10000, leaving USD 5000 under-billed.
- The 50% gap exceeds the 10% charge threshold and is not covered by an exclusion or known discount.
- The emitted ceiling is a `runx.attenuation_request.v1` data object, clamped below the USD 6000 parent bound.
- The stop fixture omits caller answers and pauses at `needs_agent`, proving no ceiling is emitted when the review is not resolved.

## Authority Boundary

- The skill performs review only; it does not move money, settle an adjustment, or charge an account.
- The skill does not mint authority and does not claim an attenuation subset proof.
- The ceiling scopes are `spend.reserve`, `spend.settle`, and `receipt.seal`.
- The ceiling names `registry:runx/spend@0.1.1` as the downstream accepting runner; that runner owns reservation, minting, settlement, and receipt sealing.
- Human approval is required before a downstream C3 runner consumes the adjustment ceiling.
- Excluded accounts, known-discount gaps, incomplete usage evidence, and incomplete billing evidence are refused or escalated rather than converted into a ceiling.

## Data Store

- The decision packet carries `registry:runx/data-store@0.1.2` as the handoff package reference.
- The graph reads `read_projection` and writes `append_event` for `account_reconciliations` keyed by `account_id`.
- Dogfood append used `expected_version: 0`, idempotency key `revenue-leakage:account:atlas-team:2026-06:detected`, and committed version `1`.
- The bundled `data.local` adapter catalog is included under this package so hosted harness execution has deterministic local data-store support.
