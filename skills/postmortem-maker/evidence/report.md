# postmortem-maker 0.1.4 delivery report

## What changed

- Added an explicit execute_publish runner that records a digest-bound mock transport send.
- Changed the public postmortem-maker graph to run decide -> execute_publish, so dogfood no longer falls through to the read-only decide runner.
- Removed the inert publish_result overclaim from decide; decide now emits publish_intent and publish_result_executed=false.
- Hardened web-fetch parsing so GitHub HTML issue pages become clean source evidence instead of noisy script timestamps.
- Kept refusal behavior for insufficient evidence.

## Published package

- Package: deltah9420/postmortem-maker@0.1.4
- Public URL: https://runx.ai/x/deltah9420/postmortem-maker@0.1.4
- Registry digest: sha256:6a7e87d0bfa21e185a87fd432a64ff8ece5785fddb3c60a1de3c7dd57198a565
- Profile digest: sha256:05abbbbabb340227afc5c01cf46c8fa1ab4fbc509199031fc264c4a3302bf4a1
- PR: https://github.com/runxhq/runx/pull/331
- Source URL: https://github.com/deltah9420/runx/tree/codex/postmortem-maker-skill/skills/postmortem-maker
- Raw X.yaml: https://raw.githubusercontent.com/deltah9420/runx/codex/postmortem-maker-skill/skills/postmortem-maker/X.yaml
- Raw SKILL.md: https://raw.githubusercontent.com/deltah9420/runx/codex/postmortem-maker-skill/skills/postmortem-maker/SKILL.md
- Verification JSON: https://raw.githubusercontent.com/deltah9420/runx/codex/postmortem-maker-skill/skills/postmortem-maker/evidence/verification.json

## Verification

- runx --version: runx-cli 0.7.1
- Local harness: passed 2 cases, graph_case_count=1.
- Hosted harness: passed for 0.1.4.
- Clean install: runx add deltah9420/postmortem-maker@0.1.4 --registry https://api.runx.ai succeeded.
- Dogfood command ran the published package with runner postmortem-maker.
- Dogfood source: https://github.com/kubernetes/kubernetes/issues/128998 fetched at run time via web-fetch.
- Dogfood receipt: runx:receipt:sha256:5da6197994b6541243596b55de8b717535d6a6dd2d83795fbad0bb6c41b22ec1
- Receipt signature: production Ed25519, kid harness-dev, runx verify valid.

## Dogfood result

- Graph status: Succeeded
- Steps: decide (decide) success; publish (execute_publish) success
- Postmortem status: publishable
- Timeline entries: 1
- Root cause status: suspected
- Unknowns: 0
- Action items: 2
- Publish decision: executed
- Send plan decision: executed
- Executed send status: sent
- Message ref: mock-send:9f56cd58d82a50fa
- Bound content digest: sha256:9f56cd58d82a50fa8836cab20ee892e6384de94636ef274c1d162d14ae527b75

## New user commands

- Install: runx add deltah9420/postmortem-maker@0.1.4 --registry https://api.runx.ai
- Run: runx skill deltah9420/postmortem-maker@0.1.4 postmortem-maker --registry https://api.runx.ai --json --skip-operator-context --input-json source_handle='"https://github.com/kubernetes/kubernetes/issues/128998"' --input-json postmortem_policy='{"publish_threshold":"when_publishable","require_root_cause":true,"max_unknowns":3}'
- Verify: runx verify --receipt <receipt-file.json> --json with trusted RUNX_RECEIPT_VERIFY_KID and RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64 for harness-dev.

## Why this addresses the review

- The dogfood no longer invokes the default decide runner.
- The graph receipt records both decide and execute_publish steps.
- publish_result is no longer an inert proposal; it contains send_plan.decision=executed and executed_send.status=sent.
- The send_plan is bound to the postmortem content digest and real source evidence.
- The receipt is production-signed, not local-development signed.
- evidence_json.dogfood includes harness_cases with the sealed and refused case statuses.
