# vendor-risk-review evidence report

## Summary
vendor-risk-review is a runx skill for relationship-level vendor trust decisions. It is not a clause redliner. It reads bounded contract text, vendor context, a supplied trust policy, data source reference, pinned store id, and prior risk record version.

## What was built
- Package: rohitmulani63-ops/vendor-risk-review@sha-a4f5ecb0c7a2
- Public URL: https://runx.ai/x/rohitmulani63-ops/vendor-risk-review@sha-a4f5ecb0c7a2
- PR: https://github.com/runxhq/runx/pull/189
- Data-store seam: registry:runx/data-store@0.1.2 append_event
- Receipt ref: runx:receipt:sha256:9222ecb7a2f81d5542ac095e6f49c5dd97d8ba0127275f50f4bb808f9822d896

## Validation
- Direct runner check for approve-with-conditions SLA gap input
- Direct runner check for rejection input covering data-handling floor and liability cap failures
- Direct runner check that missing policy fails before record write
- Docker Linux harness with runx-cli 0.6.14
- Harness cases: approve-with-conditions-sla-gap, reject-unbounded-liability-data-floor, missing-policy-stop
- Harness assertion errors: 0
- Post-publish dogfood run sealed a receipt
- runx verify returned valid true for the dogfood receipt with the trusted demo public key

## How to install and run
Run:

``bash
runx add rohitmulani63-ops/vendor-risk-review@sha-a4f5ecb0c7a2 --registry https://api.runx.ai
runx skill rohitmulani63-ops/vendor-risk-review@sha-a4f5ecb0c7a2 --registry https://api.runx.ai judge -i contract_text='...' -i data_source_ref='...' -i store_id='...' --input-json vendor_context='{...}' --input-json policy='{...}' --input-json prior_risk_record='{...}' -j
``

## Why this is useful
A reviewer can inspect the named policy fields behind each decision, the before/after data-store versions, the idempotency key, and the sealed receipt. Future operator runs can treat rejected vendors as durable risk memory instead of reconsidering the same unsafe vendor from scratch.
