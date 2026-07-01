# Escalation Judge runx Skill Delivery Report

## Package

- Owner/package: fengyangxxx/escalation-judge@sha-5b6e5530679f
- Public registry page: https://runx.ai/x/fengyangxxx/escalation-judge@sha-5b6e5530679f
- PR: https://github.com/runxhq/runx/pull/209
- Package digest: 9561d10f0bb728cbb1ff3f316476c1bec46b48688a935b3f37d1b2b3f9e281aa
- Profile digest: 2ec50b7b22d5f5fd8217b710f52466f3564fc386ea8fbaa7be5d365bdd007da6
- CLI used for publish, install, dogfood, and verify: runx-cli 0.6.14

## Verification Summary

- Local harness: passed, 4 cases, 0 assertion errors.
- Hosted registry publish: published; hosted harness passed before version sha-5b6e5530679f was published.
- Registry read: fengyangxxx/escalation-judge@sha-5b6e5530679f resolved with digest 9561d10f0bb728cbb1ff3f316476c1bec46b48688a935b3f37d1b2b3f9e281aa.
- Clean install: installed at /tmp/escalation-judge-install/fengyangxxx/escalation-judge/sha-5b6e5530679f/SKILL.md.
- Post-publish dogfood: graph Succeeded, exit code 0.
- Receipt verify: root runx:receipt:sha256:ae9cc8cf24ded9e5e12ceac7b2765440ae2e228f476b7306543371224f9420b2, valid=true, signature=valid, mode=production.

## Operator Value

The skill decides whether a support thread should open an escalation case without dispatching the downstream consequence itself. It reads prior case state, evaluates named policy thresholds and churn signals, appends a durable case record through data-store, and emits a typed escalation packet that names the downstream rail. This lets an operator audit why a priority lane was selected while keeping Slack/email/page actions in a separate governed run.

## Acceptance Coverage

- Exact package name is `escalation-judge`; published as fengyangxxx/escalation-judge@sha-5b6e5530679f.
- Typed inputs include `triage_packet`, `thread_body`, `policy_rules`, `data_source_ref`, `store_id`, `aggregate_id`, `expected_version`, and `idempotency_key`.
- State path follows `read_projection -> decide -> append_event -> readback` with pinned store ids and ungated CAS append.
- High severity / churn dogfood escalated to `priority_support`, matched `renewal_blocked`, appended `case_efd0ad8f11b130a3`, and named `downstream.slack-notify.priority-support` with `rail_effect=none`.
- Harness cases cover sealed escalation, deterministic no-change stop, missing-policy refusal, and undeclared-lane human approval routing.
- The skill refuses to invent policy lanes and does not post, send, or page directly.

## Commands

```bash
runx --version
runx harness ./skills/escalation-judge --json --receipt-dir .runx-test-receipts-escalation-judge-harness-final
runx registry publish ./skills/escalation-judge/SKILL.md --registry https://api.runx.ai --profile ./skills/escalation-judge/X.yaml --json
runx registry read fengyangxxx/escalation-judge@sha-5b6e5530679f --registry https://api.runx.ai --json
runx add fengyangxxx/escalation-judge@sha-5b6e5530679f --registry https://api.runx.ai --to /tmp/escalation-judge-install --json
runx skill fengyangxxx/escalation-judge@sha-5b6e5530679f --registry https://api.runx.ai --json -R .runx-test-receipts-escalation-judge-dogfood-final ...
runx verify --receipt skills/escalation-judge/artifacts/postpublish-dogfood-root-receipt-runx-0.6.14-linux.json --json
```

## Install, Run, Verify

```bash
runx add fengyangxxx/escalation-judge@sha-5b6e5530679f --registry https://api.runx.ai
runx skill fengyangxxx/escalation-judge@sha-5b6e5530679f --registry https://api.runx.ai --json -R .runx-receipts \
  --input-json triage_packet='{"classification":"bug","severity":"critical","confidence":0.94}' \
  -i thread_body='Enterprise tenant says production webhooks are down, renewal is blocked, and the executive sponsor may cancel.' \
  --input-json policy_rules='{"severity_thresholds":[{"name":"severity-high-or-critical","lane":"priority_support","min_severity":"high","classifications":["bug"]}],"churn_risk_signals":[{"name":"renewal_blocked","lane":"priority_support","terms":["renewal is blocked","cancel","executive sponsor"]}],"escalation_lanes":{"priority_support":{"target_rail":"downstream.slack-notify.priority-support","consequence":"internal_lane"}}}' \
  -i data_source_ref=local://runx-escalation-judge/dogfood \
  -i store_id=escalation-judge-dogfood-v2 \
  -i aggregate_id=thread:acct-9001:case-dogfood-001 \
  --input-json expected_version=0 \
  -i idempotency_key=thread:acct-9001:case-dogfood-001:escalation:v1
runx verify --receipt <receipt.json> --json
```

## Artifact Notes

Final Frantic delivery uses commit-SHA URLs for `source_url`, raw `x_yaml`, raw `skill_md`, `evidence_json`, `verification_json`, and this report. The evidence file records source file SHA256 values and the QA log records byte identity for the exact final payload. No tokens, cookies, browser storage, or private credentials are included.
