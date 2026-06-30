---
name: data-subject-request
description: Judge a data subject request, record the sealed verdict in data-store, and emit only a bounded handoff for downstream erasure or export.
runx:
  category: privacy
---

# Data Subject Request

Judge whether a data subject request is in policy without erasing, exporting, or
sending any data. The skill reads a request packet, requestor proof, policy
bounds, and prior request state. It emits one typed verdict, records that verdict
through `data-store`, and returns a bounded handoff that a separate governed
operator run may consume.

This is not a legal authority and does not replace counsel. It is an execution
boundary for policy evidence: the receipt proves which inputs were inspected,
which lawful basis was named, which scope was allowed or refused, and which
durable verdict was appended.

## Inputs

- `request_packet`: `type`, `subject_id`, and `scope`. Scope must include the
  request id, requested data classes, and requested scopes.
- `requestor_proof`: `identity_provider`, `verified_at`, and `assertion`. The
  assertion must bind the requestor to the same subject and carry a stable proof
  reference or digest.
- `policy`: `jurisdiction`, `trusted_identity_providers`, `lawful_bases`, and
  `scope_bounds`. The trusted provider list is required evidence for accepting
  the proof issuer.
- `data_source_ref` and `store_id`: the pinned data-store binding used for the
  subject request event stream.
- `aggregate_id`, `expected_version`, and `idempotency_key`: the subject request
  entity, optimistic concurrency version, and retry-safe verdict write key.

## Verdict Contract

The output is `runx.privacy.data_subject_request.v1` data:

- `decision{eligible,reason}` always appears.
- `handoff{path,subject_id,data_classes,scopes}` appears only when eligible.
- `escalation` explains whether a human lane is required.
- `verdict_event` is the exact deterministic event recorded by
  `data-store.append_event`.
- `observations` name the lawful-basis verdict, jurisdiction reason, verified
  requestor reference, identity assertion digest, scope bounds, bounded handoff,
  `aggregate_id`, `expected_version`, and `idempotency_key`.

The packet must not contain an `operational_proposal` envelope. A downstream
driver may issue a separate governed run by name, but this skill does not fire
that rail.

## State Model

State is durable in `registry:runx/data-store@0.1.2`. The graph uses the
github-sync-style shape:

1. `read_projection` loads any prior decision for the subject request entity.
2. `data-subject-request-decide` judges identity, scope, and lawful basis.
3. `append_event` records the verdict with `expected_version` and
   `idempotency_key`.
4. `read_projection` reads back the durable state for receipt evidence.

The aggregate id is the subject request entity, not a tenant-wide stream. The
append is an ungated CAS write that records the decision itself; consequences
remain downstream.

## Consequence Boundary

Eligible erasure returns a handoff such as
`downstream.data-store.append_event.subject.erasure`. A downstream operator must
issue a separate governed `data-store.append_event` run that appends a
`subject.erasure` tombstone. Erasure is event-sourced; there is no delete
operation in this skill.

Eligible export returns a handoff to a separate read path. A downstream operator
must run `read_projection`, `redact-pii`, and `send-as` under explicit approval.
This skill does not read raw content, redact content, or deliver content.

Ambiguous identity, missing proof, untrusted identity providers, scope disputes,
or data classes outside `policy.scope_bounds` escalate to a human lane or block
as `needs_agent`. The skill must refuse to invent an identity, lawful basis, or
scope that is not grounded in the inputs.

## Local Harness

Run:

```bash
runx harness ./skills/data-subject-request --json
```

The inline harness has two cases:

- `eligible-erasure-records-verdict`: a verified GDPR erasure request for
  `profile` and `support_tickets` seals, emits a bounded erasure handoff, and
  records the verdict via `data-store.append_event`.
- `unverified-requestor-refused-no-handoff`: an unsigned email proof and an
  out-of-scope `payment_methods` export request seal a deterministic refusal
  naming the jurisdiction and lawful-basis/scope grounds, with no handoff.

## Example Invocation

```bash
runx skill data-subject-request --json \
  --input-json request_packet='{"type":"erasure","subject_id":"subject:customer_4242","scope":{"request_id":"dsr-2026-06-30-001","data_classes":["profile","support_tickets"],"requested_scopes":["profile","support_tickets"]}}' \
  --input-json requestor_proof='{"identity_provider":"account-session","verified_at":"2026-06-30T14:20:00Z","assertion":{"subject_id":"subject:customer_4242","assertion_ref":"acct-session:customer_4242:2026-06-30","assertion_digest":"sha256:9d64a60e8d0c8080e88f9472c0e0ffdfad9424c2e42eb570c0f46ff3e4e73116"}}' \
  --input-json policy='{"jurisdiction":"GDPR","trusted_identity_providers":["account-session"],"lawful_bases":{"erasure":"GDPR Article 17 erasure after withdrawn consent"},"scope_bounds":{"data_classes":["profile","support_tickets"],"erasure_allowed":["profile","support_tickets"],"export_allowed":["profile","support_tickets"]}}' \
  -i data_source_ref=local://runx-data-subject-request/harness \
  -i store_id=data-subject-request-harness-v1 \
  -i aggregate_id=dsr:subject:customer_4242:request:dsr-2026-06-30-001 \
  --input-json expected_version=0 \
  -i idempotency_key=dsr-2026-06-30-001:verdict:v1
```

The runner computes only bounded policy checks from the supplied packet. If it
cannot prove identity, scope, and lawful basis from those inputs, the correct
result is a sealed refusal or human escalation, not a guessed verdict.
