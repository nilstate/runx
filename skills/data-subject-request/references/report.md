# data-subject-request verification report

## Summary

`data-subject-request` is a Runx graph-runner skill for bounded privacy request
decisions. It verifies requestor proof, checks requested classes against policy
scope bounds and lawful bases, records an append-event-shaped verdict through
the `registry:runx/data-store@0.1.2` contract, and emits a handoff only when the
request is eligible.

It does not execute erasure, export, email, notification, or any other
operational rail. Downstream erasure/export workers must consume the handoff
under separate approval and receipt gates.

## Package

- Package: `luismireles12/data-subject-request@sha-6a1d55a23739`
- Public URL: `https://runx.ai/x/luismireles12/data-subject-request`
- Required CLI observed: `runx-cli 0.6.14`
- Registry digest: `sha256:99da1950852b8306e3e6380422acc57c16128c9c7519901c06b077342e9f1b4c`

## Harness coverage

The local harness passed 2/2 cases:

1. `sealed-verified-erasure`
   - Jurisdiction: `GDPR-EU`
   - Request: erasure for `profile` and `marketing_events`
   - Requestor: verified through `acme-idp`
   - Output: `decision.eligible=true`, bounded handoff path, no rail fired,
     append-event-shaped verdict with `expected_version=0` and
     `idempotency_key=dsr:sub_123:erasure:2026-06-29:v1`.

2. `refuse-unverified-requestor`
   - Jurisdiction: `CCPA-CA`
   - Request: export for `profile`
   - Requestor: missing verified timestamp/assertion
   - Output: deterministic refusal naming the identity verification reason, no
     handoff.

Harness receipt ids:

- `sha256:5baf331bce4a1ddeb22077f04cbb5d0a82d049b66f2467cf4459464a061bbf67`
- `sha256:279fc2885fbbdbe57334e83d0551529ee8aec56d3cd9e4cfe14eef4863c1ba6c`

## Dogfood receipt

The published package was installed from the hosted registry and run against the
verified erasure fixture.

- Receipt: `runx:receipt:sha256:5829de0b2de2a313871602e43c95f88bbf998ce446b4091c78e5a9d4cd383b62`
- Verification verdict: `valid=true`
- Signature: production-mode Ed25519 receipt signature, kid `dsr-dogfood`

## Data-store evidence

The output records the intended state transition in a provider-agnostic
data-store shape:

- Dependency: `registry:runx/data-store@0.1.2`
- Sequence: `read_projection -> decide -> append_event`
- Resource: `data_subject_requests`
- Data source: `local://runx/data-subject-request`
- Pinned store id: `dsr-fixture-001`
- Aggregate id: `dsr:sub_123:erasure:2026-06-29`
- Expected version: `0`
- Idempotency key: `dsr:sub_123:erasure:2026-06-29:v1`

## Install, run, verify

Install:

```bash
runx add luismireles12/data-subject-request@sha-6a1d55a23739 --registry https://api.runx.ai
```

Run:

```bash
runx skill luismireles12/data-subject-request@sha-6a1d55a23739 --registry https://api.runx.ai --json < dsr-input.json
```

Verify the included dogfood receipt:

```bash
RUNX_RECEIPT_VERIFY_KID=dsr-dogfood \
RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64=Gk5lWkouGxDCXWMrhjrfPJzvzPlcuuqH08AmWgsjKis= \
runx verify --receipt dogfood-receipt.json --json
```
