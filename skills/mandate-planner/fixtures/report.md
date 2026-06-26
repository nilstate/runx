# mandate-planner delivery report

Package: `lxx197818/mandate-planner@0.1.0`

Public registry URL: <https://runx.ai/x/lxx197818/mandate-planner@0.1.0>

Source PR: <https://github.com/runxhq/runx/pull/151>

## What shipped

`mandate-planner` validates a proposed agency charter against an explicit
authority grant before any downstream `agency.open` run is issued. It is a
read-only judgment skill: it does not open a case, mint authority, hold state, or
call `agency.open`.

When the proposed charter is inside the grant, the skill emits
`decision.eligible: true` and a bounded `recommended_charter` carrying scopes,
spend, turn cap, counterparty, and done-check. When the charter asks for an
ungranted role, exceeds a cap, or lacks a measurable done-check, it refuses,
routes to the human approval lane, and emits no `recommended_charter`.

## Verification performed

- `runx --version`: `runx-cli 0.6.13`
- Hosted publish: `runx registry publish ./skills/mandate-planner --registry https://api.runx.ai --version 0.1.0 --profile ./skills/mandate-planner/X.yaml --json`
- Hosted registry result: published, community trust, harness passed
- Clean install: `runx add lxx197818/mandate-planner@0.1.0 --registry https://api.runx.ai`
- Dogfood run: `runx skill lxx197818/mandate-planner@0.1.0 --registry https://api.runx.ai --json`
- Dogfood receipt: `runx:receipt:sha256:3add020abdc680405b95300aab74b49d5f868e48d72ddfc3727aae69e07fd737`
- Verify verdict: valid digest, valid content address, valid Ed25519 signature

## Harness cases

- `in-grant-charter-produces-recommendation`: sealed happy path with
  `decision.eligible: true` and a bounded `recommended_charter`.
- `outside-role-escalates-to-human`: failure/stop path where the charter requests
  a role outside `authority_grant.granted_roles`; business output routes to
  `needs_agent` and emits no `recommended_charter`.

## Operator value

The skill is useful as a small guardrail before an agency driver or human
operator starts a governed agency case. It makes the authority boundary
inspectable before dispatch, and keeps the actual `agency.open` effect in a
separate governed run.
