# escalation-judge 0.1.0

`escalation-judge` decides whether a support thread should open a priority case
under explicit escalation policy, records the case through runx data-store
shape, and emits one typed escalation packet for a downstream governed driver.

## Public References

- PR: https://github.com/runxhq/runx/pull/208
- Source branch: https://github.com/ReluctantSkeptic/runx/tree/escalation-judge-public/skills/escalation-judge
- Registry: https://runx.ai/x/reluctantskeptic/escalation-judge@sha-a33725c68a9e
- Raw X.yaml: https://raw.githubusercontent.com/ReluctantSkeptic/runx/escalation-judge-public/skills/escalation-judge/X.yaml
- Raw SKILL.md: https://raw.githubusercontent.com/ReluctantSkeptic/runx/escalation-judge-public/skills/escalation-judge/SKILL.md

## Verification

- CLI version: `runx-cli 0.6.15`.
- Registry ref: `reluctantskeptic/escalation-judge@sha-a33725c68a9e`.
- `runx registry read reluctantskeptic/escalation-judge@sha-a33725c68a9e --registry https://api.runx.ai --json` resolves digest `33937553828a7e244595013d38d800d4444edd1a553cd262d167c0a2e1570b29` and profile digest `d257f28b34be9874c0ad9f3da85260fa1b8ae3e04136ed0cb33d0b6e04a3876f`.
- Clean install passed with `runx add reluctantskeptic/escalation-judge@sha-a33725c68a9e --registry https://api.runx.ai --to skills --json`.
- Local harness passed 2 cases: `escalation-judge-escalates-critical-churn` and `escalation-judge-no-change-low-risk`.
- Harness receipts: `sha256:d18d595e713abc8460c1d9a8013d572dbc43f8f91c3de63a0ff457b7fb2cd468`, `sha256:8e7ba3905296eb7c90c40e75596f02c0087044b313ee1b56a93ba8db92f9ffb7`.
- Source graph dogfood sealed receipt `sha256:ae20da9194fe1067c1cfa6bb90f01b0fd2240b51fafb93af8dc9fed795ae10e3`.
- Post-publish dogfood sealed receipt `sha256:28e87c37c691f0ed28e6d4620adb626bed085210b1b2eaa8810a257839c23603`.
- `runx verify --receipt <sha256:28e87...json> --json` returned `valid: true` with a valid Ed25519 signature.
- GitHub shows the claimant account has starred `runxhq/runx`.

## Dogfood Result

The critical churn input produced `decision.escalate = true`, lane
`priority_support`, reason `severity_threshold_matched`, case id
`case_6a99c90cde49`, data-store append operation
`read_projection -> decide -> append_event`, and target
rail `slack://support-priority`. The low-risk input sealed with
`decision.escalate = false`, no packet, no case append, and
`no_threshold_matched`.

## Install

```bash
runx add reluctantskeptic/escalation-judge@sha-a33725c68a9e --registry https://api.runx.ai
runx skill reluctantskeptic/escalation-judge@sha-a33725c68a9e --registry https://api.runx.ai --json
runx verify --receipt <receipt.json> --json
```
