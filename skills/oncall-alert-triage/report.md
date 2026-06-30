# oncall-alert-triage staging report

Package prepared for Frantic bounty #64 in `skills/oncall-alert-triage`.

## What is included

- `SKILL.md` with the package contract and operator boundary.
- `X.yaml` with two inline harness cases:
  - `sealed_escalate_checkout_alert`
  - `stop_unsealed_runbook_needs_agent`
- `run.mjs` deterministic read-only runner.
- Fixtures for the sealed escalation case and the unsealed-runbook stop case.
- `evidence.json` and `verification.json` draft artifacts.

## Local verification

Runx version:

```text
runx-cli 0.6.14
```

Skill metadata parses:

```powershell
runx skill inspect .\skills\oncall-alert-triage -j
```

Result: `status: ok`, package `oncall-alert-triage`, version `0.1.0`.

Harness attempted:

```powershell
$env:RUNX_RECEIPT_SIGN_KID='runx-demo-key'
$env:RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64='QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI='
$env:RUNX_RECEIPT_SIGN_ISSUER_TYPE='hosted'
runx harness .\skills\oncall-alert-triage --receipt-dir .\.runx-receipts --json
```

Local harness did not seal on this Windows host. Both cases failed before a
receipt id was produced with:

```text
receipt store is unreadable: 参数错误。 (os error 87)
```

Direct runner fixture checks passed with `node run.mjs`:

- Happy case: `decision.action` is `escalate`, sealed runbook digest is
  `sha256:9c8a7fc7e5d9810fcfe8e5afee0fef298b5597e8de5e2792d980e7d3a3b8d7f6`,
  and exactly one `runx.oncall.triage.v1` packet is emitted.
- Stop case: unsealed runbook produces `stop.code=runbook_unsealed`,
  `escalation.status=needs_agent`, and `packet=null`.

## Publish blockers / next steps

Do not Frantic-deliver this local staging packet as-is. The final delivery still
needs:

1. publish identity and GitHub star verifier satisfied by the claimant account;
2. public PR against `runxhq/runx` with raw `X.yaml` and `SKILL.md` URLs from the
   PR head commit;
3. local or hosted harness sealing receipts;
4. registry publish for exact package name `oncall-alert-triage`;
5. post-publish `runx add`, `runx skill`, and `runx verify` evidence;
6. final public `public_url`, `source_url`, `pr_url`, `x_yaml`, `skill_md`,
   `evidence_json`, `verification_json`, `receipt_ref`, and `report`.

