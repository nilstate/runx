# spam-risk-reviewer delivery prep report

Package prepared for Frantic bounty #62. This is not a Frantic delivery yet:
claim cooldown/identity, public PR, registry publish, hosted harness, and
post-publish receipt still need the main worker.

## What is included

- `skills/spam-risk-reviewer/X.yaml`
- `skills/spam-risk-reviewer/SKILL.md`
- `skills/spam-risk-reviewer/run.mjs`
- `skills/spam-risk-reviewer/fixtures/low-risk-verified-sender.json`
- `skills/spam-risk-reviewer/fixtures/high-risk-incomplete-auth-poor-list.json`
- `evidence.json`
- `verification.json`
- `report.md`

## Local behavior

The runner is read-only. It emits `send_risk_verdict` with:

- `risk_level`
- `preflight_clear`
- `blockers`
- `evidence_summary`

It explicitly marks `public_send`, `operational_proposal`, authority minting,
and domain-state writes as false. Non-clear verdicts route to
`send-as.human_approval`; send-as remains the only owner of the `public_send`
effect.

## Verified commands

Runx version:

```powershell
& "C:\Users\DFGS\Documents\自动化盈利\tools\runx-0.6.14\runx-0.6.14-x86_64-pc-windows-msvc\runx.exe" --version
```

Output:

```text
runx-cli 0.6.14
```

Inspect:

```powershell
& "C:\Users\DFGS\Documents\自动化盈利\tools\runx-0.6.14\runx-0.6.14-x86_64-pc-windows-msvc\runx.exe" skill inspect .\skills\spam-risk-reviewer --json
```

Status: passed.

Harness attempted:

```powershell
$env:RUNX_RECEIPT_SIGN_KID="runx-demo-key"
$env:RUNX_RECEIPT_SIGN_ISSUER_TYPE="hosted"
$env:RUNX_RECEIPT_DIR="C:\tmp\runx-frantic-spam-receipts"
& "C:\Users\DFGS\Documents\自动化盈利\tools\runx-0.6.14\runx-0.6.14-x86_64-pc-windows-msvc\runx.exe" harness .\skills\spam-risk-reviewer --json
```

Status: blocked on this Windows machine with `receipt store is unreadable:
参数错误。 (os error 87)`.

Direct runner dogfood passed for both fixtures. The low-risk fixture yields
`risk_level: pass`, `preflight_clear: true`, `blockers: []`. The high-risk
fixture yields `risk_level: hold`, `preflight_clear: false`, DKIM and list
hygiene blockers, and `needs_human.lane: send-as.human_approval`.

## Commands still required before Frantic delivery

```bash
runx login --provider github --for publish
runx harness ./skills/spam-risk-reviewer
runx registry publish ./skills/spam-risk-reviewer/SKILL.md --registry https://api.runx.ai
runx add <owner>/spam-risk-reviewer@0.1.0
runx skill <owner>/spam-risk-reviewer@0.1.0 --json ...
runx verify --receipt <receipt.json> --json
runx registry read <owner>/spam-risk-reviewer@0.1.0 --json
```

Then open a public PR against `runxhq/runx` and replace all placeholder artifact
refs in `evidence.json`.
