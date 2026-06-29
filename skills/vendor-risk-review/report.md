# Vendor risk review skill delivery report

- Package: `iwannabefree00/vendor-risk-review@sha-f73efbe9b874`
- Public URL: https://runx.ai/x/iwannabefree00/vendor-risk-review@sha-f73efbe9b874
- PR: https://github.com/runxhq/runx/pull/172
- Source package path: `skills/vendor-risk-review/`
- CLI used: `runx-cli 0.6.14`
- Install command: `runx add iwannabefree00/vendor-risk-review@sha-f73efbe9b874 --registry https://api.runx.ai`
- Run command: `runx skill iwannabefree00/vendor-risk-review@sha-f73efbe9b874 --registry https://api.runx.ai --json`

## What the skill does

- Reads `contract_text`, `vendor_context`, `policy`, `data_source_ref`, and a pinned `store_id`.
- Compares vendor contract terms against the supplied trust policy, including `required_sla_terms`, `max_liability`, `data_handling_floor`, `termination_window`, `policy_id`, and `created_at`.
- Emits a typed `decision` and, when policy evidence is complete, appends a durable vendor risk event through `registry:runx/data-store@0.1.2`.
- Uses `aggregate_id` equal to the vendor entity and an idempotency key derived from `vendor_ref + policy_id + decision`.
- Stops before any write when policy fields are missing, vendor identity is ambiguous, or prior state is unreadable.

## Verification summary

- Hosted registry harness: `passed`
- Hosted harness endpoint: https://api.runx.ai/v1/skills/iwannabefree00/vendor-risk-review@sha-f73efbe9b874/harness
- Harness cases:
  - `approve-with-conditions-sla-gap`: sealed approve-with-conditions path; missing SLA language is grounded in `policy.required_sla_terms`.
  - `sealed-rejection-unbounded-liability`: sealed rejection path; refusal is grounded in liability/data-handling policy floors.
  - `stop-missing-policy-no-write`: failed/stop path with no data-store write.
- Hosted harness receipt ids:
  - `sha256:b4038bf730b6f5a3150d669cb414ad9805ba3b8e87bb3bf32886d24b172156c1`
  - `sha256:956be8c7d155300a9d5173c1193a2f09a557589d216337e6b831fe60df9a3705`
  - `sha256:057a970f41271160885671b5bbadc8a003af901c840880e4f5c18efe472257ab`

## Dogfood proof

- GitHub Actions run: https://github.com/iwannabefree00/runx/actions/runs/28356975016
- Action status: `passed`
- Dogfood receipt: `runx:receipt:sha256:39ac11170b0aa565bb96ba58d1e6115c149ce068906478dd5fb930d36442d5f9`
- `skills/vendor-risk-review/action-verification.json` records the published ref, receipt, case outputs, and runx verification output.
- Frantic delivery `c7d9683f-e4dc-482e-a214-699317218c4b` passed machine verification `20/20`; the subsequent auto-review fallback reported an advisory review-infrastructure failure before judging the delivery.

## Operator value

- A buyer can install the published package without private context and run it against a vendor contract plus trust policy.
- The output is useful for procurement/security review because it turns vendor risk criteria into a durable, source-grounded decision record.
- Rejections are intentionally durable records, so future operator runs do not reconsider a previously unsafe vendor relationship without new policy evidence.
- The skill avoids the receipt ledger as state and keeps the governed notification/send-as lane outside this package.
