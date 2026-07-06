# support-desk Frantic delivery report

## Summary
- Added support-desk, a non-mutating Runx skill for turning bounded support threads plus docs/policy into one safe operator proposal lane.
- Published package: ohitmulani63-ops/support-desk@sha-0b7352252dca.
- Public URL: https://runx.ai/x/rohitmulani63-ops/support-desk@sha-0b7352252dca
- PR: https://github.com/runxhq/runx/pull/265
- Source: https://github.com/rohitmulani63-ops/runx/tree/support-desk-frantic-78/skills/support-desk

## What changed
- skills/support-desk/X.yaml declares the package, inputs, outputs, and harness.
- skills/support-desk/SKILL.md documents operator use, safety boundary, output schema, validation, and install/run flow.
- skills/support-desk/run.mjs implements reply_only, issue_intake_proposal, followup_plan, and manual_review lanes.
- Evidence files live under skills/support-desk/evidence/.

## Safety boundary
- Does not send customer messages.
- Does not open tickets or GitHub issues.
- Does not mutate accounts, billing, credentials, permissions, legal, or security state.
- Sensitive/private-state requests route to manual review.
- Unsupported claims remain followup/manual instead of being invented.

## Validation
- unx --version: unx-cli 0.6.14.
- unx skill inspect ./skills/support-desk -j: passed.
- Docker/Linux harness passed with 3 cases:
  - docs-grounded-reply-only: sealed
  - sensitive-billing-security-manual-review: sealed
  - missing-thread-failure: failure stop
- Clean install passed with unx registry install rohitmulani63-ops/support-desk@sha-0b7352252dca --registry https://api.runx.ai.
- Hosted registry read resolves owner, version, digest, and profile digest.
- Post-publish dogfood run used ohitmulani63-ops/support-desk@sha-0b7352252dca, not the local folder.
- Dogfood receipt: unx:receipt:sha256:2675b5c3409619563fe800988f32d1f591bba2962a5091a60fb230058389e36c.
- unx verify on that dogfood receipt returned alid: true.

## Dogfood result
The post-publish dogfood run produced a eply_only proposal grounded in docs-domain-verify, with no side effects, no customer send, no ticket open, and no account mutation.

## New user flow
1. Install: unx add rohitmulani63-ops/support-desk@sha-0b7352252dca --registry https://api.runx.ai.
2. Run with bounded support_thread, docs_corpus or source_catalog, customer_context, and support_policy.
3. Verify the dogfood receipt with unx verify sha256:2675b5c3409619563fe800988f32d1f591bba2962a5091a60fb230058389e36c --receipt-dir .runx/support-desk-published-receipts --json.