# quote-guard delivery report

## Package

- Package: vidshidden/quote-guard@sha-74fbe6322db5
- Public URL: https://runx.ai/x/vidshidden/quote-guard@sha-74fbe6322db5
- PR URL: https://github.com/runxhq/runx/pull/226
- Source URL: https://github.com/VidsHidden/runx/tree/quote-guard/skills/quote-guard
- Raw X.yaml: https://raw.githubusercontent.com/VidsHidden/runx/quote-guard/skills/quote-guard/X.yaml
- Raw SKILL.md: https://raw.githubusercontent.com/VidsHidden/runx/quote-guard/skills/quote-guard/SKILL.md
- Evidence JSON: https://raw.githubusercontent.com/VidsHidden/runx/quote-guard/skills/quote-guard/evidence/evidence.json
- Verification JSON: https://raw.githubusercontent.com/VidsHidden/runx/quote-guard/skills/quote-guard/evidence/verification.json
- Report: https://raw.githubusercontent.com/VidsHidden/runx/quote-guard/skills/quote-guard/evidence/report.md

## Verification

- runx CLI version: runx-cli 0.6.14.
- Publish method: direct equivalent of `runx registry publish ./skills/quote-guard/SKILL.md --registry https://api.runx.ai` using the same remote /v1/skills API.
- Hosted harness status: passed, cases in_policy_deal_yields_quote, out_of_band_ask_escalates.
- Clean install command: `runx add vidshidden/quote-guard@sha-74fbe6322db5 --registry https://api.runx.ai`.
- Dogfood command: `runx skill vidshidden/quote-guard@sha-74fbe6322db5 --registry https://api.runx.ai --json -R skills/quote-guard/evidence/dogfood-receipts`.
- Dogfood receipt: runx:receipt:sha256:40d3e3eb579b09aba7357db66ee8d8b867a68922d2ecca9ae6b2ab111c299bc8.
- runx verify verdict: valid; signature mode production.
- Windows local harness status: failed; Ubuntu workflow records the durable dogfood evidence.

## Behavior

- `in_policy_deal_yields_quote` authorizes account acct_acme_001 in policy band standard-ae.
- The quote draft has digest sha256:caedb6bbe5177b165e8a0a02b5bdf75c1d18bb231a5697860dfec9d473ff921e; the report does not require live sending.
- `send_proposal` is gated and names downstream `send-as`; `this_skill_sends` is false.
- `settlement_ceiling` is USD 25800, capped by policy band standard-ae.
- Prior quote evidence is sourced only from supplied quote_history records: q_2026_041.
- `out_of_band_ask_escalates` refuses reason outside_policy_band; it emits no send proposal and no settlement ceiling.

## New User

- Install: `runx add vidshidden/quote-guard@sha-74fbe6322db5 --registry https://api.runx.ai`.
- Run with bounded JSON inputs matching `fixtures/in-policy-deal.json`.
- Verify receipts with `runx verify --receipt-dir skills/quote-guard/evidence/dogfood-receipts --json`.
- Trust this skill only as a pricing guard and proposal generator; it never sends quotes, mints authority, settles funds, or writes account policy.
