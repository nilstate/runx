# Harness Evidence — agency-health@0.1.0

This file is the harness evidence required by the Frantic #106 acceptance
criteria. It accompanies `skills/agency-health/X.yaml` so a reviewer can run
the same deterministic harness the worker ran, without private context.

## Harness contract (X.yaml)

The skill declares two inline harness cases, both with `expect.status: sealed`:

| Case name | Purpose | Expected outcome |
| --- | --- | --- |
| `concerning-agency-sealed` | A running agency over a 37-day period with 42 events, 2 parked turns (1 stuck 4 days), 2 refused turns, and 82% cap pressure. | `decision: ready`, `health_verdict.status: degraded`, graded findings include `cap_usage_pct: concerning`, one `policy-author` intervention finding. |
| `no-case-events-stop` | A fresh agency whose case stream has zero readable events over the same period. | `decision: needs_more_evidence`, empty findings, empty intervention_findings, one refusal with `when: no_case_events`. A deterministic conflict that still seals. |

## How to replay

From the repo root:

```bash
runx harness ./skills/agency-health/SKILL.md --json
```

Expected output shape (truncated):

```json
{
  "status": "passed",
  "case_count": 2,
  "assertion_error_count": 0,
  "assertion_errors": [],
  "case_names": ["concerning-agency-sealed", "no-case-events-stop"],
  "receipt_ids": ["sha256:...", "sha256:..."]
}
```

## Fixture layout

```
skills/agency-health/fixtures/
  ds:agency-fixtures/
    store-a/
      agency-007/
        case-001/
          events.json          # 42 events: 38 advanced, 2 awaiting_approval, 2 refused
          charter.json         # case_id, agency_ref, mandate, roster, limits, cumulative
      agency-008/
        case-empty/
          events.json          # []
          charter.json         # empty agency: 0 acts, 0 spend
  ledger/
    ledger-stub-001.json       # one audit-only receipt stub (read by id only)
```

The data-store read_projection runner (C2) reads `events.json` in version
order; the ledger read runner (C7) reads `ledger/<stub>.json` by id-stub only.
Both runners are deterministic, audit-only, and free of side effects.

## Dogfood — post-publish invocation

Once published, the dogfood invocation a reviewer can run from a fresh shell:

```bash
runx skill <owner>/agency-health@0.1.0 --json \
  --input-json data_source_ref='"ds:agency-fixtures"' \
  --input-json store_id='"store-a"' \
  --input-json agency_ref='"agency-007"' \
  --input-json case_id='"case-001"' \
  --input-json period='{"since":"2026-06-01T00:00:00Z","until":"2026-07-08T00:00:00Z"}' \
  --input-json health_baseline='{"threshold_days_stuck":3,"cap_pressure_pct":80,"refusal_spike_rate":0.10}' \
  --input-json ledger_id_stubs='["ledger-stub-001"]'
```

Then verify the receipt:

```bash
runx verify --receipt-dir .runx/receipts <receipt-id> --json
```

The reviewer should see `valid: true`, `signature_mode: production`, no
findings, and `signature_status: valid`. The receipt must NOT embed the
signing key; only the Ed25519 signature is exposed.

## Refusals

The skill refuses:

- a signal not grounded in the folded case projection or a ledger id-stub
  aggregate,
- a cap or threshold it cannot read from the agency charter snapshot or the
  supplied baseline, and
- a turn state the sealed event order does not show.

When the case stream has zero readable events over the period, the verdict is
`needs_more_evidence`, no findings are graded, and no intervention is emitted.
The case is recorded in `refusals` with `when: no_case_events`.

## Handoff seam

Each intervention finding names a target lane and grounds it in a `case_id`
and a turn or a ledger id-stub. The skill moves no money and grants no access;
each finding is consumed only when a downstream driver or operator issues the
separate `policy-author`, `improve-skill`, or human-ops run.
