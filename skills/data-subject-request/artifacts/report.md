# data-subject-request Frantic #71 Report

Status: ready for independent QA; not submitted to Frantic.

## Package

- Owner/package/version: `fengyangxxx/data-subject-request@sha-5e61052d6ca5`.
- Public registry page: https://runx.ai/x/fengyangxxx/data-subject-request@sha-5e61052d6ca5 (canonical listing also resolves at https://runx.ai/x/fengyangxxx/data-subject-request).
- PR: https://github.com/runxhq/runx/pull/192.
- Source used for publish: https://github.com/fengyangxxx/runx/tree/f9675dfe46709886ea009f2245145bb87f21b359/skills/data-subject-request.
- Raw package files for review: https://raw.githubusercontent.com/fengyangxxx/runx/f9675dfe46709886ea009f2245145bb87f21b359/skills/data-subject-request/X.yaml and https://raw.githubusercontent.com/fengyangxxx/runx/f9675dfe46709886ea009f2245145bb87f21b359/skills/data-subject-request/SKILL.md.

## What the skill does

- Reads a typed data subject request packet, requestor proof, jurisdiction policy, and pinned data-store binding.
- Loads prior request state with `read_projection`, deterministically judges identity/scope/lawful basis, records `subject_request.verdict_recorded` with `append_event`, then reads back the projection for receipt evidence.
- Emits `decision{eligible,reason}`, `escalation`, and only when eligible a bounded `handoff{path,subject_id,data_classes,scopes}`. It emits no `operational_proposal` and fires no erasure/export rail itself.
- Eligible erasure handoff is only data for a downstream governed `data-store.append_event` run that appends a `subject.erasure` tombstone. Eligible export is only a downstream `read_projection + redact-pii + send-as` path under explicit approval.
- Refuses untrusted identity providers, missing requestor proof, data classes outside `policy.scope_bounds`, and any invented identity or lawful basis.

## Commands and evidence

- `runx --version`: `runx-cli 0.6.14`.
- Publish: `npx -y @runxhq/cli@0.6.14 registry publish ./skills/data-subject-request/SKILL.md --registry https://api.runx.ai --profile ./skills/data-subject-request/X.yaml --json` -> `success`, published version `sha-5e61052d6ca5`.
- Registry read: `runx registry read fengyangxxx/data-subject-request@sha-5e61052d6ca5 --registry https://api.runx.ai --json` -> `success`.
- Clean install: `npx -y @runxhq/cli@0.6.14 add fengyangxxx/data-subject-request@sha-5e61052d6ca5 --registry https://api.runx.ai --to /tmp/runx-clean --json` -> `success`, runners `decide, judge`.
- Local harness: `runx harness ./skills/data-subject-request --json` -> `passed`, 2 cases, receipts sha256:1104ce5cb414b391b03f68dc3a0a14e3237ba9f9d934fa7f65a5963f63f6923d, sha256:7475dfb674888c6cde3538e4ea8c80c300df097b25a351aac47f0b4c13a4497d.
- Post-publish dogfood: `npx -y @runxhq/cli@0.6.14 skill fengyangxxx/data-subject-request@sha-5e61052d6ca5 --registry https://api.runx.ai --json -R .runx-test-receipts-data-subject-request-dogfood-postpublish-fixture --input-json request_packet=<fixtures/dogfood-erasure-input.json.request_packet> --input-json requestor_proof=<fixtures/dogfood-erasure-input.json.requestor_proof> --input-json policy=<fixtures/dogfood-erasure-input.json.policy> -i data_source_ref=<fixture.data_source_ref> -i store_id=<fixture.store_id> -i aggregate_id=<fixture.aggregate_id> -i idempotency_key=<fixture.idempotency_key> --input-json expected_version=<fixture.expected_version>` -> `sealed`, receipt `sha256:261771ae3340aa2439a152f1138b0bbd662fa177fea6da44bd07a6b1505bfde8`.
- Verify: `npx -y @runxhq/cli@0.6.14 verify sha256:261771ae3340aa2439a152f1138b0bbd662fa177fea6da44bd07a6b1505bfde8 --receipt-dir .runx-test-receipts-data-subject-request-dogfood-postpublish-fixture --json` -> `valid=true`, signature mode `production`, receipt count 5.
- Remote inspect: `runx skill inspect fengyangxxx/data-subject-request@sha-5e61052d6ca5 --registry https://api.runx.ai --json` -> `ok`.
- Doctor: `runx doctor --json` -> `success` with 0 errors; warnings are pre-existing unrelated package warnings and none are data-subject-request diagnostics.

## Dogfood result

- Decision: `{"eligible":true,"reason":"GDPR erasure request is eligible: verified account-session proof matches subject:customer_7001, lawful basis is supplied, and scope is bounded to profile, marketing_preferences."}`.
- Handoff: `{"data_classes":["profile","marketing_preferences"],"path":"downstream.data-store.append_event.subject.erasure","scopes":{"downstream_operator_required":true,"erasure_event_type":"subject.erasure","rail_effect":"none","request_type":"erasure","requested_scopes":["profile","marketing_preferences"]},"subject_id":"subject:customer_7001"}`.
- Verdict event: `subject_request.verdict_recorded`, aggregate `dsr:subject:customer_7001:request:dsr-2026-06-30-dogfood-001`, expected_version `0`, idempotency_key `dsr-2026-06-30-dogfood-001:verdict:v1`.
- Lawful basis and jurisdiction: `GDPR Article 17 erasure after withdrawn consent, with retention exceptions screened by policy. => eligible`; `GDPR policy supplied for request dsr-2026-06-30-dogfood-001.`.
- Verified requestor: `acct-session:customer_7001:2026-06-30`; assertion digest `sha256:6f41f68e5636f1b542f47370f214d1f58870d7bc4b8a8c922fc8ab9601aa3f3c`.
- Scope bounds: `profile, support_tickets, marketing_preferences`; bounded handoff `downstream.data-store.append_event.subject.erasure for profile, marketing_preferences only`.

## Harness cases

- `eligible-erasure-records-verdict`: sealed; eligible GDPR erasure request records verdict and emits bounded handoff.
- `unverified-requestor-refused-no-handoff`: policy_denied/refused; unsigned email proof and out-of-bounds `payment_methods` scope produce no handoff.

## New user flow

1. Install with `runx add fengyangxxx/data-subject-request@sha-5e61052d6ca5 --registry https://api.runx.ai`.
2. Run with `runx skill fengyangxxx/data-subject-request@sha-5e61052d6ca5 --registry https://api.runx.ai --json` and the typed request_packet/requestor_proof/policy/data-store inputs.
3. Verify the dogfood receipt with `npx -y @runxhq/cli@0.6.14 verify sha256:261771ae3340aa2439a152f1138b0bbd662fa177fea6da44bd07a6b1505bfde8 --receipt-dir .runx-test-receipts-data-subject-request-dogfood-postpublish-fixture --json` using the recorded receipt directory or equivalent trusted receipt source.

## Operator value

- The skill turns a high-risk legal/process judgment into a sealed, replayable policy decision with durable event-sourced state.
- It makes the dangerous consequence explicit by not erasing/exporting data; it returns a bounded handoff for a separately governed operator run.
- Receipts preserve the identity proof reference, assertion digest, lawful basis, scope bounds, aggregate id, CAS version, idempotency key, and final verdict.

## Known regression coverage

- Prior #71 auto-review complained that `evidence_json.dogfood.command` was missing; this packet includes the exact dogfood command in `evidence_json.dogfood.command`.
- Prior #71 auto-review complained about receipt verification; this packet includes `postpublish-dogfood-verify-runx-0.6.14-linux.json` with `valid=true` for `sha256:261771ae3340aa2439a152f1138b0bbd662fa177fea6da44bd07a6b1505bfde8`.
