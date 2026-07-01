# escalation-judge local evidence commands

These commands are pre-publication development evidence for Frantic #69. They do
not replace final PR, registry publish, hosted harness, post-publish dogfood,
QA PASS, or delivery artifacts.

```bash
node scripts/generate-official-lock.mjs
pnpm build
pnpm exec tsx packages/cli/src/index.ts doctor --json
docker run --rm -v "$PWD:/repo" -w /repo node:24-bookworm node scripts/check-authoring-package-contract.mjs
```

```bash
docker run --rm \
  -v "$PWD:/repo" \
  -w /repo \
  -e npm_config_update_notifier=false \
  -e RUNX_RECEIPT_SIGN_KID=frantic-69-local-harness-key \
  -e RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64=QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI= \
  -e RUNX_RECEIPT_SIGN_ISSUER_TYPE=hosted \
  node:24-bookworm \
  bash -lc "npx -y @runxhq/cli@0.6.14 harness ./skills/escalation-judge --json --receipt-dir .runx-test-receipts-escalation-judge-harness-final"
```

```bash
# Dogfood command was run through a stdin Node wrapper that read
# skills/escalation-judge/fixtures/dogfood-critical-input.json and invoked:
npx -y @runxhq/cli@0.6.14 skill ./skills/escalation-judge --json \
  -R .runx-test-receipts-escalation-judge-dogfood-final \
  --input-json triage_packet=<fixture.triage_packet> \
  --input-json policy_rules=<fixture.policy_rules> \
  -i thread_body=<fixture.thread_body> \
  -i data_source_ref=<fixture.data_source_ref> \
  -i store_id=<fixture.store_id> \
  -i aggregate_id=<fixture.aggregate_id> \
  -i idempotency_key=<fixture.idempotency_key> \
  --input-json expected_version=<fixture.expected_version>
```

```bash
docker run --rm \
  -v "$PWD:/repo" \
  -w /repo \
  -e npm_config_update_notifier=false \
  -e RUNX_RECEIPT_VERIFY_KID=frantic-69-local-harness-key \
  -e RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64=IVL40Zt5HSRFMkLhXy6rbLfP+ntqXtMAl5YOBpiB2xI= \
  node:24-bookworm \
  bash -lc "npx -y @runxhq/cli@0.6.14 verify --receipt-dir .runx-test-receipts-escalation-judge-dogfood-final --json"
```
