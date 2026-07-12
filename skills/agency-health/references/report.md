# Agency Health runx Skill Report

- Package: `zdfgu113/agency-health@0.1.0`.
- Public registry page: https://runx.ai/x/zdfgu113/agency-health.
- Source PR: https://github.com/runxhq/runx/pull/280.
- CLI used: `runx-cli 0.6.14`.
- Publish command: `runx registry publish ./skills/agency-health/SKILL.md --registry https://api.runx.ai --version 0.1.0 --json`.
- Clean install command: `runx add zdfgu113/agency-health@0.1.0 --registry https://api.runx.ai`.
- Local harness passed with `concerning-agency-sealed`, `no-case-events-stop`, and `missing-agency-ref-stop`.
- Hosted registry publish succeeded with digest `09fe302df90eac52cde2714e227cec733d1c7707b591dac6efc6546ea41ea476` and profile digest `2254aceaaad882fc296790c72f64352b7a9fb6980bc89aa67295c55da233b7cb`.
- Published dogfood run sealed on `zdfgu113/agency-health@0.1.0` with receipt `runx:receipt:sha256:d68c9236383b3fe5822829539f904ea1e639203ad146e3b137bd094ae6fdb88b`.
- The degraded dogfood verdict is grounded in case `case-retention-2026-07`, turns 11, 12, and 13, and ledger id-stubs `rcpt_agency_12a` and `rcpt_agency_13b`.
- Findings cover `seal_rate`, `stuck_case_count`, `cap_usage_pct`, and `escalation_backlog`.
- Intervention findings route by name only to `policy-author` and `improve-skill`; the skill moves no money, grants no access, emits no ceiling, and executes no rail.
- The no-events path returns `needs_more_evidence` with no findings and no intervention.
- `published-verification.json` records the exact `runx verify` verdict. Digest and content address are valid; this local runx build reports the demo signature encoding as malformed, so the final delivery also includes registry read, clean install, hosted publish, and sealed dogfood evidence.

## How to Install and Run

```bash
runx add zdfgu113/agency-health@0.1.0 --registry https://api.runx.ai
runx skill zdfgu113/agency-health@0.1.0 --registry https://api.runx.ai \
  --input data_source_ref=fixture://agency \
  --input store_id=agency-health-fixtures \
  --input agency_ref=agency://growth-retention \
  --input period=7d \
  --input case_id=case-retention-2026-07 \
  --json
```

## How to Verify

```bash
runx registry read zdfgu113/agency-health@0.1.0 --registry https://api.runx.ai --json
runx harness ./skills/agency-health --json
runx verify --receipt <receipt.json> --allow-local-development-signatures --json
```
