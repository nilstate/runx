# Escalation Judge Command Evidence

Generated: 2026-07-01T22:41:06.580Z

- runx version: runx-cli 0.6.14
- doctor: pnpm --silent exec tsx packages/cli/src/index.ts doctor --json > skills/escalation-judge/artifacts/doctor-final-prepublish.json
- official lock: node scripts/generate-official-lock.mjs
- build: pnpm build
- package contract: docker run ... node scripts/check-authoring-package-contract.mjs
- local harness: docker run ... npx -y @runxhq/cli@0.6.14 harness ./skills/escalation-judge --json --receipt-dir .runx-test-receipts-escalation-judge-harness-final
- publish: docker run ... npx -y @runxhq/cli@0.6.14 registry publish ./skills/escalation-judge/SKILL.md --registry https://api.runx.ai --profile ./skills/escalation-judge/X.yaml --json
- registry read: docker run ... npx -y @runxhq/cli@0.6.14 registry read fengyangxxx/escalation-judge@sha-5b6e5530679f --registry https://api.runx.ai --json
- clean install: docker run ... npx -y @runxhq/cli@0.6.14 add fengyangxxx/escalation-judge@sha-5b6e5530679f --registry https://api.runx.ai --to /tmp/escalation-judge-install --json
- dogfood command:

```bash
npx -y @runxhq/cli@0.6.14 skill fengyangxxx/escalation-judge@sha-5b6e5530679f --registry https://api.runx.ai --json -R .runx-test-receipts-escalation-judge-dogfood-final --input-json triage_packet={"classification":"bug","severity":"critical","confidence":0.94} --input-json policy_rules={"severity_thresholds":[{"name":"severity-high-or-critical","lane":"priority_support","min_severity":"high","classifications":["bug","account_access"]}],"churn_risk_signals":[{"name":"renewal_blocked","lane":"priority_support","terms":["renewal is blocked","cancel","executive sponsor"]}],"escalation_lanes":{"priority_support":{"target_rail":"downstream.slack-notify.priority-support","consequence":"internal_lane"}}} -i thread_body=Enterprise customer reports production webhook delivery is down. Their renewal is blocked and the executive sponsor says they will cancel unless priority support owns the incident today. -i data_source_ref=local://runx-escalation-judge/dogfood -i store_id=escalation-judge-dogfood-v2 -i aggregate_id=thread:acct-9001:case-dogfood-001 -i idempotency_key=thread:acct-9001:case-dogfood-001:escalation:v1 --input-json expected_version=0
```

- verify tree: docker run ... npx -y @runxhq/cli@0.6.14 verify --receipt-dir .runx-test-receipts-escalation-judge-dogfood-final --json
- verify root: docker run ... npx -y @runxhq/cli@0.6.14 verify --receipt skills/escalation-judge/artifacts/postpublish-dogfood-root-receipt-runx-0.6.14-linux.json --json
