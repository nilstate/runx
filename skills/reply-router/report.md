# Reply router skill delivery report

- Package: `iwannabefree00/reply-router@sha-243e8add9e86`
- Public URL: https://runx.ai/x/iwannabefree00/reply-router@sha-243e8add9e86
- PR: https://github.com/runxhq/runx/pull/175
- Source package path: `skills/reply-router/`
- Raw X.yaml artifact: https://raw.githubusercontent.com/iwannabefree00/runx/reply-router-skill/skills/reply-router/X.yaml
- Raw SKILL.md artifact: https://raw.githubusercontent.com/iwannabefree00/runx/reply-router-skill/skills/reply-router/SKILL.md
- Raw evidence artifact: https://raw.githubusercontent.com/iwannabefree00/runx/reply-router-skill/skills/reply-router/evidence.json
- Raw verification artifact: https://raw.githubusercontent.com/iwannabefree00/runx/reply-router-skill/skills/reply-router/action-verification.json
- CLI used: `runx-cli 0.6.14`
- Install command: `runx add iwannabefree00/reply-router@sha-243e8add9e86 --registry https://api.runx.ai`
- Run command: `runx skill iwannabefree00/reply-router@sha-243e8add9e86 --registry https://api.runx.ai --json`

## What the skill does

- Reads an inbound reply, the sealed original-send receipt, a suppression policy, `data_source_ref`, and pinned `store_id`.
- Classifies reply types such as unsubscribe, interested, objection, out-of-office, wrong-person, and ambiguous.
- For unsubscribe replies, prepares a recipient-keyed suppression `append_event` through `registry:runx/data-store@0.1.2`.
- For routed non-unsubscribe replies, emits a typed `runx.reply.routing.v1` packet naming a bounded downstream send target.
- Stops before write or routing when the original receipt is unsealed, malformed, ambiguous, or below confidence threshold.
- Never sends a message, emits no `AttenuationRequest`, and emits no `operational_proposal` envelope.

## Verification summary

- Exact `runx --version` output captured for this delivery: `runx-cli 0.6.14`
- Hosted registry harness: `passed`
- Hosted harness endpoint: https://api.runx.ai/v1/skills/iwannabefree00/reply-router@sha-243e8add9e86/harness
- Harness cases:
  - `sealed_unsubscribe_suppression`: sealed unsubscribe path; writes a suppression append_event packet and emits no routing decision.
  - `stop_ambiguous_or_unsealed`: failed stop path; unsealed/malformed receipt causes human escalation, no suppression write, and no routing decision.
- Hosted receipt ids:
  - `sha256:16c62fb5326eb78a8a65d0935114e3f4a6263e4068ca2f4b19f31500bdcdd343`
  - `sha256:831863b7403416597860d7553aa8c3059a32edd1536360b0630c602a62a5e6f8`

## Dogfood proof

- GitHub Actions run: https://github.com/iwannabefree00/runx/actions/runs/28358412442
- Action status: `passed`
- Dogfood receipt: `runx:receipt:sha256:c05323d5e2df75fe6f0fd2ba2aae3a8322e347033ecd84831a9bacde5d51e791`
- `skills/reply-router/action-verification.json` records the published ref, install output, dogfood output, receipt id, and runx verification output.

## Operator value

- A user can install the package without private context and classify replies from a workflow or CRM export.
- The suppression record becomes a durable compliance block that a later governed send-as preflight can read fail-closed.
- Unsubscribe replies cannot be accidentally routed alongside a send target.
- Non-unsubscribe routing is bounded and deferred to a separate governed send-as run, keeping this skill safe and auditable.
