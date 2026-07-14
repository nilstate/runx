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
  `runx:receipt:sha256:0ebb7dedbb2d3ef67b6f217808252b7a765cbad0962e1fc51b71aa08a760bbc8`.
- `no-case-events-stop`: `needs_more_evidence`, `unknown`, zero findings, and
  zero interventions. Top receipt:
  `runx:receipt:sha256:ecfb3f093fb74bc9928d26f74c60dc1924de8d00e4f68b8ff7c353f23880b83b`.

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
`runx:receipt:sha256:40781dfd36e9fbd45d3e1df43e98418b66b59dd6f921dc22650a32698e679da7`.

Verification returned `valid: true`, production signature mode, signature
status `valid`, and no findings. Signing material is intentionally absent from
this package. Post-publication registry harness and dogfood receipts are
reported separately in the bounty evidence so they can prove registry
identity and clean-install behavior.
