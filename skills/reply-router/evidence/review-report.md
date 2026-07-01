# reply-router Review Report

## Scope

- Package: `reply-router`
- Version: `0.1.0`
- Registry ref: `armstrongsam25/reply-router@sha-0625cc484acf`
- Published URL: https://runx.ai/x/armstrongsam25/reply-router
- Source revision: `0625cc484acf2f31ad760b1e6f13be633e9052a1`
- PR: https://github.com/runxhq/runx/pull/210
- Runtime: `runx-cli 0.6.15`

## Verification Summary

- Public registry read resolves `armstrongsam25/reply-router@sha-0625cc484acf` and records source provenance for `armstrongsam25/runx-reply-router-skill@0625cc484acf2f31ad760b1e6f13be633e9052a1`.
- Local harness passed 2 cases with 0 assertion errors.
- Post-publish dogfood run produced receipt `runx:receipt:sha256:ee9832472e7f25e1804f497efdb96bc716520607cdb80ef4774854d8f2ec65f0`.
- `runx verify` returned `valid=true`, digest `valid`, content address `valid`, signature `valid` with kid `runx-demo-key`.
- Dogfood output decision is `suppress` with classification `unsubscribe` at confidence 0.99.

## Harness Cases

- `sealed_unsubscribe_suppression`: sealed original send receipt plus unsubscribe text produces an unsubscribe classification, suppression append_event, recipient aggregate, deterministic idempotency key, before_version 7, and after_version 8.
- `stop_ambiguous_or_unsealed`: ambiguous text with an unsealed original receipt blocks to `needs_agent` and emits no suppression write or routing decision.

## Operator Value

- The skill prevents later sends to recipients who clearly opted out by committing a durable suppression record.
- It names `registry:runx/data-store@0.1.2` and uses CAS-style `expected_version` so reviewers can inspect the state transition.
- It keeps routed replies separate from sending; the output names a later governed `send-as` run and never sends directly.
- It refuses unsealed send receipts and ambiguous content, which keeps uncertain replies in a human review lane.
- A new user can install, run, and verify the skill without private context using the commands below.

## Commands

```bash
runx add armstrongsam25/reply-router@sha-0625cc484acf --registry https://api.runx.ai
runx registry read armstrongsam25/reply-router@sha-0625cc484acf --registry https://api.runx.ai --json
runx harness ./skills/reply-router --json
runx skill armstrongsam25/reply-router@sha-0625cc484acf dogfood --registry https://api.runx.ai --input-json ... --receipt-dir receipts --json
runx verify --receipt receipts/sha256:ee9832472e7f25e1804f497efdb96bc716520607cdb80ef4774854d8f2ec65f0.json --json
```

## Safety Review

- No network calls inside the skill scripts.
- No hidden credentials or tokens in artifacts.
- No message sending.
- No suppression without matched unsubscribe evidence in the reply text and policy.
- No route when the original send receipt is unsealed.
- No invented classification outside the inbound content.

## How a New User Installs, Runs, and Verifies

- Install: `runx add armstrongsam25/reply-router@sha-0625cc484acf --registry https://api.runx.ai`
- Run: `runx skill armstrongsam25/reply-router@sha-0625cc484acf dogfood --registry https://api.runx.ai --input-json inbound_reply=... --json`
- Verify: `runx verify --receipt <receipt.json> --json` returns `valid=true`
- The skill is self-contained with no external dependencies beyond Node.js.
