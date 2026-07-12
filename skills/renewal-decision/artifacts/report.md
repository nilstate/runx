# renewal-decision delivery report

## Package

- Public URL: https://runx.ai/x/dh0h/renewal-decision@sha-23e7a258c30a
- Registry package: `dh0h/renewal-decision@sha-23e7a258c30a`
- PR: https://github.com/runxhq/runx/pull/278
- Source: https://github.com/dh0h/runx/tree/codex/renewal-decision-110/skills/renewal-decision

## Verification

- `runx-cli 0.6.19` satisfies the `0.6.14+` requirement.
- Local harness passed with exactly two cases: one sealed renew case and one `needs_agent` stop case.
- Hosted registry publish gate passed and published version `sha-23e7a258c30a`.
- Registry read and install both resolved the package with runner `decide`.
- Published-package dogfood run sealed receipt `runx:receipt:sha256:c430d1034f64321e98aaf568e0091bcee57d9328b65f1daf20efc0b938932e8a`.
- Receipt verification passed with a 4-receipt tree and no findings.

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
