# reply-router - Review Report

## Scope

- Package: `reply-router`
- Version: `0.1.0`
- Registry ref: `<owner>/reply-router@<version>`
- Published URL: `https://runx.ai/x/<owner>/reply-router@<version>`
- Source revision: `<commit-sha>`
- PR: `https://github.com/runxhq/runx/pull/<number>`
- Runtime: `runx-cli 0.6.14`

## Verification Summary

- Public registry read resolves `<owner>/reply-router@<version>` and records source provenance.
- Hosted/Linux harness passed 2 cases with 0 assertion errors.
- Post-publish dogfood run produced signed and valid receipt.
- `runx verify` returned `valid=true`, digest valid, content address valid, signature valid.
- Dogfood output decision is `suppress` with classification `unsubscribe` at high confidence.

## Harness Cases

| Case | Status | Result |
|------|--------|--------|
| `sealed_unsubscribe_suppression` | sealed | Unsubscribe suppression path closes with sealed receipt, CAS append_event, no routing |
| `stop_ambiguous_or_unsealed` | refused | Ambiguous/unsealed blocks to `needs_agent`, no suppression or routing |

## Operator Value

The skill prevents later sends to recipients who clearly opted out by committing a durable suppression record to `registry:runx/data-store@0.1.2`. It uses CAS-style `expected_version` writes for race-safe suppression. Routed replies are kept separate from sending - the output names a later governed `send-as` run and never sends directly. Ambiguous and unsealed receipts are diverted to a human review lane.

## Safety Review

- No network calls inside skill scripts.
- No hidden credentials or tokens in artifacts.
- No message sending by the skill.
- No suppression without matched unsubscribe evidence.
- No route when original send receipt is unsealed.
- No invented classification outside inbound content.

## Commands

```bash
runx add <owner>/reply-router@<version> --registry https://api.runx.ai
runx registry read <owner>/reply-router@<version> --registry https://api.runx.ai --json
runx harness ./skills/reply-router --json
runx skill <owner>/reply-router@<version> --registry https://api.runx.ai --input-json ... --receipt-dir receipts --json
runx verify --receipt receipts/<sha256>.json --json
```
