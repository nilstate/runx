# reply-router Review Report

## Scope

- Package: `reply-router`
- Version: `0.1.0`
- Registry ref: `jaasieldelgado131/reply-router@sha-016598c4eb75`
- Published URL: https://runx.ai/x/jaasieldelgado131/reply-router@sha-016598c4eb75
- Source revision: `016598c4eb7599c2ce0ba705fb835fd0dab4ed01`
- PR: https://github.com/runxhq/runx/pull/173
- Runtime: `runx-cli 0.6.14`

## Verification Summary

- Public registry read resolves `jaasieldelgado131/reply-router@sha-016598c4eb75` and records source provenance for `jaasieldelgado131/runx-reply-router-skill@016598c4eb7599c2ce0ba705fb835fd0dab4ed01`.
- Hosted/Linux harness passed 2 cases with 0 assertion errors.
- Post-publish dogfood run produced receipt `runx:receipt:sha256:7a6023af6a9c117f5dbb53cf7af89fe594f2083c002d79484c6fa4ecfd760ccf`.
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

## Commands

```bash
runx add jaasieldelgado131/reply-router@sha-016598c4eb75 --registry https://api.runx.ai
runx registry read jaasieldelgado131/reply-router@sha-016598c4eb75 --registry https://api.runx.ai --json
runx harness ./skills/reply-router --json
runx skill jaasieldelgado131/reply-router@sha-016598c4eb75 dogfood --registry https://api.runx.ai --input-json ... --receipt-dir receipts --json
runx verify --receipt receipts/sha256:7a6023af6a9c117f5dbb53cf7af89fe594f2083c002d79484c6fa4ecfd760ccf.json --json
```

## Safety Review

- No network calls inside the skill scripts.
- No hidden credentials or tokens in artifacts.
- No message sending.
- No suppression without matched unsubscribe evidence in the reply text and policy.
- No route when the original send receipt is unsealed.
- No invented classification outside the inbound content.
