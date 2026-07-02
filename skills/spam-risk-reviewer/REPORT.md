# Spam Risk Reviewer Verification Report

- Runtime: every publish, install, dogfood, and verify step used `runx-cli 0.6.14`.
- Publisher: `bbbbzzzzcc-afk`.
- Package: `bbbbzzzzcc-afk/spam-risk-reviewer@sha-cf7c9972e03d`.
- Registry: the immutable version resolves with digest `9b4a14b2fcc82ed83ee5663d1cb9bfddb3ec237bd23f9de453750487cc08dd68`.
- Public adoption page: <https://runx.ai/x/bbbbzzzzcc-afk/spam-risk-reviewer@sha-cf7c9972e03d>.
- Source and PR: the package is public in <https://github.com/runxhq/runx/pull/214> and in the publisher fork.
- Harness: the hosted publish gate passed exactly two cases with zero assertion errors.
- Clear case: `low-risk-verified-sender` sealed `risk_level=pass`, `preflight_clear=true`, and no blockers from full authentication and clean list evidence.
- Stop case: `high-risk-incomplete-auth-poor-list` returned `risk_level=hold`, `preflight_clear=false`, failed DKIM and bounce-rate blockers, and a recoverable `needs_agent` state for the human approval lane.
- Policy comparisons: bounce rate is capped at 2%, complaint rate at 0.1%, freshness at 180 days, warm-up requires 14 days, and SPF, DKIM, and DMARC must all pass.
- Content boundary: a digest does not reveal message content, so the skill never invents content-risk flags.
- Effect boundary: `send-as` is only a named downstream handoff. This skill never owns `public_send`, delivers a message, reads domain state, mints authority, or emits `runx.operational_proposal.v1`.
- Clean install: `runx add bbbbzzzzcc-afk/spam-risk-reviewer@sha-cf7c9972e03d --registry https://api.runx.ai` succeeded in an empty destination.
- Dogfood: a real published-package run over a verified sender and clean 2,400-address list sealed receipt `sha256:694e8fe8aac9d8baf67b640f63f6ebb27be0e294f018e559085c80cb74a4668f`.
- Receipt verification: `runx verify` returned `valid=true`, production signature mode, and no findings.
- Public receipt: the signed receipt is included as `dogfood-receipt.json` so a reviewer can fetch and inspect it without private context.
- New users can install with the clean-install command, run the exact registry ref with three JSON inputs, and verify the resulting receipt with `runx verify <receipt-id> --receipt-dir <dir> --json`.
