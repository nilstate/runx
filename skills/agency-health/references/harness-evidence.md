# Harness evidence

This package was exercised with `runx-cli 0.7.0` before publication. The
commands below use the package as checked in; they do not inject health metrics
or findings from the caller.

## Native inline harness

```text
runx harness ./skills/agency-health --json
```

The two named cases sealed successfully:

- `concerning-agency-sealed`: `ready`, `degraded`, four health findings, and
  two grounded intervention findings. Top receipt:
  `runx:receipt:sha256:99356ab5eb70f07d965ab91bea34bb2e10742fe9f820e27b9ffa90997965ec71`.
- `no-case-events-stop`: `needs_more_evidence`, `unknown`, zero findings, and
  zero interventions. Top receipt:
  `runx:receipt:sha256:e297b82b5c5b5fdb24d834b53cc9a9ca67370a87b14df0427534f9177d8310e4`.

Both runs executed the same graph stages: `prepare`, `read-projection`,
`read-events`, `read-ledger`, `project-ledger-stubs`, `read-case-ledger`, and
`grade`.

## Durable pre-publication dogfood

A separate run read the durable local case `case-frantic-revenue-001` for
`agent-17af92`, whose event stream records the real Frantic revenue workflow.
It sealed `needs_human` / `critical` with four findings and one `human-ops`
intervention grounded in turns 1 and 2 plus the two receipt id-stubs already
cited by those case events.

The ambient ledger read returned no id-stub cited by this case, so the graph's
second `ledger.read` used the two receipt rows projected from the ordered case
events. The output records `case-referenced-ledger-read` rather than implying
that unrelated ambient rows grounded the grade.

Top receipt:
`runx:receipt:sha256:3421f851f6a556d0bdc06f91c77ca90d1805b3327f5598a9afc554ea11aac0ce`.

Verification returned `valid: true`, production signature mode, signature
status `valid`, and no findings. Signing material is intentionally absent from
this package. Post-publication registry harness and dogfood receipts are
reported separately in the bounty evidence so they can prove registry
identity and clean-install behavior.
