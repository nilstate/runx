# Vendor risk review skill delivery

- Package: `vendor-risk-review`
- Version: `0.1.0`
- Owner: `iwannabefree00`
- PR: https://github.com/runxhq/runx/pull/172
- Source branch: https://github.com/iwannabefree00/runx/tree/vendor-risk-review/skills/vendor-risk-review
- Intended registry URL: https://runx.ai/x/iwannabefree00/vendor-risk-review@0.1.0

## What changed

- Added `skills/vendor-risk-review/SKILL.md` with typed input/output documentation and the governed data-store seam.
- Added `skills/vendor-risk-review/X.yaml` with three inline harness cases:
  - `approve-with-conditions-sla-gap`
  - `sealed-rejection-unbounded-liability`
  - `stop-missing-policy-no-write`
- Added `skills/vendor-risk-review/run.mjs`, a deterministic CLI runner for policy-based vendor review.

## Decision behavior

- Approves with conditions when the contract has recoverable SLA or termination gaps but no hard risk blockers.
- Rejects when liability is unlimited, uncapped, unbounded, above `policy.max_liability`, or data handling is below `policy.data_handling_floor`.
- Stops before write when the vendor is ambiguous, policy fields are missing, or prior projection state is unreadable.
- Emits an append-event-ready risk record for `registry:runx/data-store@0.1.2` whenever the vendor and policy packet are complete.

## Verification notes

- `runx skill inspect skills/vendor-risk-review --json` passed with runx-cli `0.6.14`.
- Direct dogfood execution of `run.mjs` with the approve-with-conditions fixture passed and emitted:
  - `decision.approved = true`
  - one remediation condition
  - `data_store.sequence = ["read_projection", "decide", "append_event"]`
  - `append_event.aggregate_id = vendor_context.vendor_ref`
- On this Windows host, `runx harness` fails before executing both this skill and the upstream `examples/hello-world` fixture with `receipt store is unreadable: os error 87`. The inline harness is still included for Frantic/runx verifier execution on a compatible host.

## User install/run/verify

- Install after publish:
  - `runx add iwannabefree00/vendor-risk-review@0.1.0 --registry https://api.runx.ai`
- Run:
  - `runx skill iwannabefree00/vendor-risk-review@0.1.0 --registry https://api.runx.ai --json`
- Verify receipt:
  - `runx verify --receipt <receipt.json> --json`
