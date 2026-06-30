# outreach-sequencer delivery report

## Package

- Package: vidshidden/outreach-sequencer@sha-8248a4585211
- Public URL: https://runx.ai/x/vidshidden/outreach-sequencer@sha-8248a4585211
- PR URL: https://github.com/runxhq/runx/pull/PLACEHOLDER
- Source URL: https://github.com/VidsHidden/runx/tree/outreach-sequencer/skills/outreach-sequencer
- Raw X.yaml: https://raw.githubusercontent.com/VidsHidden/runx/outreach-sequencer/skills/outreach-sequencer/X.yaml
- Raw SKILL.md: https://raw.githubusercontent.com/VidsHidden/runx/outreach-sequencer/skills/outreach-sequencer/SKILL.md
- Evidence JSON: https://raw.githubusercontent.com/VidsHidden/runx/outreach-sequencer/skills/outreach-sequencer/evidence/evidence.json
- Verification JSON: https://raw.githubusercontent.com/VidsHidden/runx/outreach-sequencer/skills/outreach-sequencer/evidence/verification.json
- Report: https://raw.githubusercontent.com/VidsHidden/runx/outreach-sequencer/skills/outreach-sequencer/evidence/report.md

## Verification

- runx CLI version: runx-cli 0.6.14.
- Publish method: direct equivalent of `runx registry publish ./skills/outreach-sequencer/SKILL.md --registry https://api.runx.ai` using the same remote /v1/skills API because Windows local publish harness hits receipt-store os error 87.
- Hosted harness status: passed, cases happy_next_touch, stop_replied, missing_state_needs_agent.
- Clean install command: `runx add vidshidden/outreach-sequencer@sha-8248a4585211 --registry https://api.runx.ai`.
- Dogfood command: `runx skill vidshidden/outreach-sequencer@sha-8248a4585211 --registry https://api.runx.ai --json -R skills/outreach-sequencer/evidence/dogfood-receipts`.
- Dogfood receipt: runx:receipt:sha256:07dc416636da29e35ec4b3672001506737990080c11e76954a2f84da5e4e49ec.
- runx verify verdict: valid; signature mode production.
- Windows local dogfood status: failure; expected receipt-store issue is recorded in dogfood-output-windows.json.

## Behavior

- `happy_next_touch` reads data-store projection version 7, sees no reply or unsubscribe, and emits one `runx.outreach.next_touch.v1` handoff packet for touch 3.
- The packet is handoff-only: it names `send-as`, keeps `this_skill_sends: false`, and requires a separate governed downstream run.
- The append event is ungated, uses idempotency key `outreach-sequencer:seq-acme-001:contact-jane:touch3`, and moves version 7 to 8.
- `stop_replied` reads a linked reply event and seals with no next-touch packet.
- `missing_state_needs_agent` returns `needs_agent` for unreadable engagement state instead of guessing.

## New User

- Install: `runx add vidshidden/outreach-sequencer@sha-8248a4585211 --registry https://api.runx.ai`.
- Run with bounded JSON inputs matching `fixtures/happy-next-touch.json`.
- Verify receipts with `runx verify --receipt-dir skills/outreach-sequencer/evidence/dogfood-receipts --json`.
- Trust the skill only as a decision and handoff packet generator; it never sends outreach or mints dispatch authority.
