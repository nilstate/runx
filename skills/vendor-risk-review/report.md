# Vendor risk review skill delivery

- Package: `vendor-risk-review`
- Published ref: `iwannabefree00/vendor-risk-review@sha-cc5115a1c103`
- Owner: `iwannabefree00`
- Public URL: https://runx.ai/x/iwannabefree00/vendor-risk-review@sha-cc5115a1c103
- PR: https://github.com/runxhq/runx/pull/172
- Publish source: https://github.com/iwannabefree00/runx/tree/cc5115a1c1034577bb9bf14bcc9f68715326cd38/skills/vendor-risk-review

## What shipped

- Added `skills/vendor-risk-review/SKILL.md` with typed input/output documentation and the governed data-store seam.
- Added `skills/vendor-risk-review/X.yaml` with three inline harness cases:
  - `approve-with-conditions-sla-gap`
  - `sealed-rejection-unbounded-liability`
  - `stop-missing-policy-no-write`
- Added `skills/vendor-risk-review/run.mjs`, a deterministic CLI runner for policy-based vendor relationship decisions.
- Published the package through runx URL-as-publish from the public GitHub source after the interactive GitHub OAuth path returned 404.

## Decision behavior

- Approves with conditions when the contract has recoverable SLA or termination gaps but no hard risk blockers.
- Rejects when liability is unlimited, uncapped, unbounded, above `policy.max_liability`, or data handling is below `policy.data_handling_floor`.
- Stops before write when the vendor is ambiguous, policy fields are missing, or prior projection state is unreadable.
- Emits an append-event-ready risk record for `registry:runx/data-store@0.1.2` whenever the vendor and policy packet are complete.

## Verification notes

- `runx --version` output: `runx-cli 0.6.14`.
- `runx registry read iwannabefree00/vendor-risk-review@sha-cc5115a1c103 --registry https://api.runx.ai --json` resolved owner, version, digest, profile digest, publisher, install command, and run command.
- `runx add iwannabefree00/vendor-risk-review@sha-cc5115a1c103 --registry https://api.runx.ai --json` installed `SKILL.md`, `X.yaml`, and `run.mjs`.
- `https://api.runx.ai/v1/skills/iwannabefree00/vendor-risk-review/harness` returned HTTP 200 and listed all three declared harness cases.
- GitHub Actions sealed the inline harness cases and emitted `action-verification.json` with receipt `runx:receipt:sha256:edbc4b5bf7adc3aafb6de9a7da7591032739ce1e4cc2c90c5af19ff465d6fdab`.
- The workflow now dogfoods the published registry ref directly; on this Windows host, a post-publish rerun reaches receipt initialization but runx fails before execution with `receipt store is unreadable: os error 87`.

## User install/run/verify

- Install:
  - `runx add iwannabefree00/vendor-risk-review@sha-cc5115a1c103 --registry https://api.runx.ai`
- Run:
  - `runx skill iwannabefree00/vendor-risk-review@sha-cc5115a1c103 --registry https://api.runx.ai --json`
- Verify receipt:
  - `runx verify --receipt <receipt.json> --json`

## Why it is useful

- Procurement or security operators can turn a supplied trust policy into a reproducible relationship-level approve/conditional/reject decision.
- The output names the policy fields behind each condition or refusal instead of inventing unsupported risk claims.
- The durable handoff is a CAS-style `append_event` packet for `registry:runx/data-store@0.1.2`, so future runs can remember both approvals with conditions and hard rejections.
