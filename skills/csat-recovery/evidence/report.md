# CSAT Recovery 0.2.0 Revision Report

- Published package: `q10283245/csat-recovery@0.2.0`.
- Public adoption page: <https://runx.ai/x/q10283245/csat-recovery@0.2.0>.
- Public review PR: <https://github.com/runxhq/runx/pull/308>.
- Source revision: `6c5be505906d601fe741a5e3164dc3b2c226c2ae`.
- Official Runx hosted harness: 2/2 checks passed, receipt `sha256:92401bbc74a06fc0fa66dc6974ec9a7bafd72cfcb14832e77ab290b9d2258935`.
- Independent production-signed source harness: receipt `runx:receipt:sha256:cfb79811028ffaba77ba12c95d8529beb0e72d7bb363ba0793195bc46f401946`, verified with valid digest, content address, and Ed25519 signature.

## Durable data-store correction

The graph no longer treats `prior_recovery_ref` as the monthly total. Before judgment it calls `data.source` with `operation: read_projection`, keyed by `customer_context.id`, `recovery_month`, and the declared `recovery_events` resource. The evaluator receives the returned `monthly_recovery_total_minor` and projection version.

The production-signed harness seeded an 800-minor-unit July recovery for `customer-redacted-17`. The read returned aggregate version 1 and total 800. The bounded decision added 1,200 units and left 3,000 units under the 5,000-unit monthly ceiling.

After human review, an ungated `append_event` wrote the emitted `state_event`. Its `expected_version` came directly from the earlier read projection. The adapter committed version 1 to version 2. A final `read_projection` returned version 2, two monthly events, and a recomputed total of 2,000 minor units.

The shipped `data.local` adapter implements `append_event`, `read`, and `read_projection` in `tools/data/local/run.mjs`; its manifest declares the event-stream resource and required scope contract. The public package acquisition includes both adapter files.

The unlinked-credit case remains fail-closed at `needs_agent` and emits no money ceiling. The graph performs no refund, send, mint, reservation, or settlement; it only emits a bounded ceiling, a naming-only send plan, and the durable audit event.

## Public artifacts

- Raw profile: <https://raw.githubusercontent.com/q10283245/runx/6c5be505906d601fe741a5e3164dc3b2c226c2ae/skills/csat-recovery/X.yaml>
- Raw instructions: <https://raw.githubusercontent.com/q10283245/runx/6c5be505906d601fe741a5e3164dc3b2c226c2ae/skills/csat-recovery/SKILL.md>
- Registry install: `runx add q10283245/csat-recovery@0.2.0 --registry https://api.runx.ai --digest fb068b53e4336bc1d23e45d80b61049a537853e9914e51499950e4a0a8f16926`
