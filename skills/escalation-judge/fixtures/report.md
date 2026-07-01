# escalation-judge 0.1.0

`escalation-judge` decides whether a support thread should open a priority case
under explicit escalation policy, records the case through runx data-store
shape, and emits one typed escalation packet for a downstream governed driver.

## Public References

- PR: https://github.com/runxhq/runx/pull/208
- Source branch: https://github.com/ReluctantSkeptic/runx/tree/escalation-judge-public/skills/escalation-judge
- Raw X.yaml: https://raw.githubusercontent.com/ReluctantSkeptic/runx/escalation-judge-public/skills/escalation-judge/X.yaml
- Raw SKILL.md: https://raw.githubusercontent.com/ReluctantSkeptic/runx/escalation-judge-public/skills/escalation-judge/SKILL.md

## Verification

- CLI version: `runx-cli 0.6.15`.
- Local harness passed 2 cases: `escalation-judge-escalates-critical-churn` and `escalation-judge-no-change-low-risk`.
- Harness receipts: `sha256:d18d595e713abc8460c1d9a8013d572dbc43f8f91c3de63a0ff457b7fb2cd468`, `sha256:8e7ba3905296eb7c90c40e75596f02c0087044b313ee1b56a93ba8db92f9ffb7`.
- Source graph dogfood sealed receipt `sha256:ae20da9194fe1067c1cfa6bb90f01b0fd2240b51fafb93af8dc9fed795ae10e3`.
- `runx verify --receipt <sha256:ae20...json> --json` returned `valid: true` with a valid Ed25519 signature.
- GitHub shows the claimant account has starred `runxhq/runx`.

## Dogfood Result

The critical churn input produced `decision.escalate = true`, lane
`priority_support`, reason `severity_threshold_matched`, case id
`case_41022d2bf207`, append ref `escalation_cases:thread-4821:1`, and target
rail `slack://support-priority`. The low-risk input sealed with
`decision.escalate = false`, no packet, no case append, and
`no_threshold_matched`.

## Registry Status

The implementation is ready for hosted publication, but publication is currently
blocked by external hosted services: Runx Connect opened a blank OAuth popup and
the OAuth endpoint returned HTTP 502 during GitHub login; the unauthenticated
URL index path for the focused public branch returned `rate_limited` while
resolving GitHub. Once the registry accepts the package, the expected install
path is:

```bash
runx add <owner>/escalation-judge@<version>
runx skill <owner>/escalation-judge@<version> --json
runx verify --receipt <receipt.json> --json
```
