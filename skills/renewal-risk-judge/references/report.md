# renewal-risk-judge delivery report

## Summary

`renewal-risk-judge` emits one `runx.support.renewal_risk.v1` packet from bounded usage, support, and payment inputs. It produces a `decision`, an `escalation`, and a `save_plan` only for high or critical renewal risk.

The save plan is only a recommendation. The skill sends no message, mints no authority, reads no private account state, and includes no amount, currency, or counterparty. Any actual customer communication must happen in a separate governed `send-as` run with human approval.

## Verification

- runx version: `runx-cli 0.6.13`
- package name: `renewal-risk-judge`
- version: `0.1.0`
- local harness: passed
- harness cases: `high_risk_with_save_play`, `missing_usage_signals_stop`, `missing_required_usage_failure`
- dogfood receipt: `runx:receipt:sha256:033f2803da11f7663f5b5738c8660b6eadc682db42df2272eb24f9081d001559`
- verify verdict: valid digest, valid content address, valid production Ed25519 signature, no findings

## High-risk case

The high-risk fixture supplies declining usage with `mau_pct_change: -38`, support volume `14`, average support severity `4.2`, payment `18` days late, and `churn_flag: true`.

The judge fuses these signals with weights:

- usage trend and MAU change: `0.45`
- support volume and severity: `0.25`
- payment lateness and churn flag: `0.30`

The dogfood run emits `decision.risk_level: critical` and one bounded save plan:

- channel: `email`
- audience: `account:acme-renewal-2026`
- content_ref: `renewal-save-play:account:acme-renewal-2026:risk-critical`

## Stop case

The stop fixture omits usable usage trend data. The judge refuses to qualify the account, routes to `human_approval`, names the missing usage signal, and emits no save plan.

The harness also includes `missing_required_usage_failure`, which omits the required `usage_signals` object entirely. That case fails before skill execution and proves the package has a real runx stop/error path for hosted registry verification, not only sealed success receipts.

## Composition with send-as

High or critical outcomes may name a downstream `send-as` lane by verdict, but no send can happen from this skill. A downstream driver or operator must start a separate governed `send-as` run, bind message content, and obtain human approval.

Moderate and edge-case accounts route to human approval and cannot fire `send-as` without that approval.
