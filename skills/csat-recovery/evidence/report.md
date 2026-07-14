# CSAT Recovery 0.2.0 Revision Report

- Published package: `q10283245/csat-recovery@0.2.0`.
- Public adoption page: <https://runx.ai/x/q10283245/csat-recovery@0.2.0>.
- Public review PR: <https://github.com/runxhq/runx/pull/308>.
- Source revision: `6c5be505906d601fe741a5e3164dc3b2c226c2ae`.
- Official Runx hosted harness: 2/2 checks passed, receipt `sha256:92401bbc74a06fc0fa66dc6974ec9a7bafd72cfcb14832e77ab290b9d2258935`.
- Production-signed published-package dogfood: `runx skill q10283245/csat-recovery@0.2.0 ... --json`, sealed run `run_csat-recovery-with-prior-fixture_e9d586943185`, receipt `runx:receipt:sha256:62107fb8d14e8e05b013c32fd1e8e54072ee49d8695067048b6b6a1b828981b3`, verified with valid digest, content address, and Ed25519 signature.

## Published-package dogfood

The official acquisition endpoint returned `q10283245/csat-recovery@0.2.0` with a `runx.registry.signed_manifest.v1` manifest signed by `runx-hosted-registry` / `runx-registry-ed25519-v1`. Its registry, profile, and package digests are respectively `fb068b53e4336bc1d23e45d80b61049a537853e9914e51499950e4a0a8f16926`, `9b85a7ff6d99b7e5acc6ec955605faab56a00766af19a01d2fcdae15f864e03e`, and `09e79e866a2438f7f12e839b90355505938b422380bff1d52a6a259ce95c440e`. The acquisition also contains the declared `tools/data/local/manifest.json` and `tools/data/local/run.mjs` package files.

The exact acquired markdown, profile, and package files were materialized under the literal `q10283245/csat-recovery@0.2.0` path, then invoked with `runx skill q10283245/csat-recovery@0.2.0 csat-recovery-with-prior-fixture ... --json`. This preserves the official signed package bytes while avoiding only a local VPN DNS mapping that resolves `api.runx.ai` to a reserved synthetic address rejected by Runx's registry SSRF guard. The invocation sealed successfully and is the dogfood evidence; the separate hosted harness remains corroboration, not a substitute for the skill invocation.

## Durable data-store correction

The graph no longer treats `prior_recovery_ref` as the monthly total. Before judgment it calls `data.source` with `operation: read_projection`, keyed by `customer_context.id`, `recovery_month`, and the declared `recovery_events` resource. The evaluator receives the returned `monthly_recovery_total_minor` and projection version.

The production-signed published-package dogfood seeded an 800-minor-unit July recovery for `customer-redacted-17`. The read returned aggregate version 1 and total 800. The bounded decision added 1,200 units and left 3,000 units under the 5,000-unit monthly ceiling.

After human review, an ungated `append_event` wrote the emitted `state_event`. Its `expected_version` came directly from the earlier read projection. The adapter committed version 1 to version 2. A final `read_projection` returned version 2, two monthly events, and a recomputed total of 2,000 minor units.

The shipped `data.local` adapter implements `append_event`, `read`, and `read_projection` in `tools/data/local/run.mjs`; its manifest declares the event-stream resource and required scope contract. The public package acquisition includes both adapter files.

The unlinked-credit case remains fail-closed at `needs_agent` and emits no money ceiling. The graph performs no refund, send, mint, reservation, or settlement; it only emits a bounded ceiling, a naming-only send plan, and the durable audit event.

## Public artifacts

- Raw profile: <https://raw.githubusercontent.com/q10283245/runx/6c5be505906d601fe741a5e3164dc3b2c226c2ae/skills/csat-recovery/X.yaml>
- Raw instructions: <https://raw.githubusercontent.com/q10283245/runx/6c5be505906d601fe741a5e3164dc3b2c226c2ae/skills/csat-recovery/SKILL.md>
- Registry install: `runx add q10283245/csat-recovery@0.2.0 --registry https://api.runx.ai --digest fb068b53e4336bc1d23e45d80b61049a537853e9914e51499950e4a0a8f16926`
