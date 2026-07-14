# Harness evidence

This package was exercised with `runx-cli 0.7.0` before publication. The
commands below use the package as checked in; they do not inject health metrics
or findings from the caller.

## Native inline harness

```text
runx harness ./skills/agency-health --json
```

The two contractual domain cases sealed successfully:

- `concerning-agency-sealed`: `ready`, `degraded`, four health findings, and
  two grounded intervention findings. Top receipt:
  `runx:receipt:sha256:ac9dfc4b302158e1846322f5244c131ab04051386614e77e2e7a80d3fe91cd19`.
- `no-case-events-stop`: `needs_more_evidence`, `unknown`, zero findings, and
  zero interventions. Top receipt:
  `runx:receipt:sha256:40f80613549a80be5420087a344dfd60a8b6e32c784c555a1a41ff63909205c7`.

Both runs executed the same graph stages: `prepare`, `read-projection`,
`read-events`, `read-ledger`, `project-ledger-stubs`, `read-case-ledger`, and
`grade`.

The registry-admission boundary `missing-agency-ref-needs-agent` also passed:
the runtime stopped as `needs_agent` before any graph read when the required
agency identity was omitted. It is intentionally separate from the two domain
cases above.

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
