# deliverability-judge staging report

Package prepared for Frantic bounty #65 in `skills/deliverability-judge`.

## What is included

- `SKILL.md` with the package contract and read-only authority boundary.
- `X.yaml` with two inline harness cases:
  - `sealed_healthy_signals_continue`
  - `contradictory_signals_escalate`
- `run.mjs` deterministic read-only runner.
- Fixtures for healthy sealed signals, contradictory signals, and policy.
- `evidence.json` and `verification.json` draft artifacts.

## Local verification

Runx version:

```text
runx-cli 0.6.14
```

Skill metadata parses:

```powershell
runx skill inspect .\skills\deliverability-judge -j
```

Result: `status: ok`, package `deliverability-judge`, version `0.1.0`.

Harness attempted:

```powershell
$env:RUNX_RECEIPT_SIGN_KID='runx-demo-key'
$env:RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64='QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI='
$env:RUNX_RECEIPT_SIGN_ISSUER_TYPE='hosted'
runx harness .\skills\deliverability-judge --receipt-dir .\.runx-receipts --json
```

Local harness did not seal on this Windows host. Both cases failed before a
receipt id was produced with:

```text
receipt store is unreadable: 参数错误。 (os error 87)
```

Direct runner fixture checks passed with `node run.mjs`:

- Healthy case: `verdict.state=healthy`, confidence window `[0.84, 0.93]`,
  and `recommendation.action=continue` with evidence hash
  `sha256:1668a0c0a3b883f6e67ffa181b79a75d6853dc57ada91df148c5e063af40810c`.
- Contradictory case: high reputation plus high bounce/strong placement
  refuses fusion with `escalation.code=contradictory_signals` and
  `recommendation=null`.

## Publish blockers / next steps

Do not Frantic-deliver this local staging packet as-is. The final delivery still
needs:

1. publish identity and GitHub star verifier satisfied by the claimant account;
2. public PR against `runxhq/runx` with raw `X.yaml` and `SKILL.md` URLs from the
   PR head commit;
3. local or hosted harness sealing receipts;
4. registry publish for exact package name `deliverability-judge`;
5. post-publish `runx add`, `runx skill`, and `runx verify` evidence;
6. final public `public_url`, `source_url`, `pr_url`, `x_yaml`, `skill_md`,
   `evidence_json`, `verification_json`, `receipt_ref`, and `report`.

