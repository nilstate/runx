# Agency Health revision evidence

This revision replaces fixture-file reads in the production runner with a three-step runtime graph:

1. `../data-store` → `read_projection`, keyed by the live agency case aggregate ID.
2. `../ledger` → `read`, producing governed receipt ID stubs.
3. `./` → `fold`, consuming the two graph outputs as `projection_packet` and `ledger_packet`.

The production `run.mjs` no longer resolves or reads fixture files. Fixtures remain limited to harness setup.

## Verification

- Source commit: `1e6863727f0095b6fec28d6aad2aa2cd5b34ac9d`.
- Node syntax and YAML manifest checks passed.
- Live case `case-health-live-001` folded 7 turns, produced 4 graded findings and 2 intervention findings, and sealed as `aa2dabaaa6716cf61a4343f23c937fb37c54426018a51bbdcb6d23ac8fc911f0`.
- Live case `case-health-live-002` folded 10 turns, produced 3 healthy graded findings and no interventions, and sealed as `201c9f1c06d6cbf6852d0a869cad55bfee7d822cf07279ec0f6a45d62f976a23`.

The accompanying `verification.json` and `evidence.json` provide machine-readable validation and graph/receipt evidence.
