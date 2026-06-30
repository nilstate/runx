# data-subject-request local evidence commands

These commands are pre-publication development evidence for Frantic #71. They do
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
  -e RUNX_RECEIPT_SIGN_KID=frantic-71-local-harness-key \
  -e RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64=<local-demo-seed> \
  -e RUNX_RECEIPT_SIGN_ISSUER_TYPE=hosted \
  node:24-bookworm \
  bash -lc "npx -y @runxhq/cli@0.6.14 harness ./skills/data-subject-request --json --receipt-dir .runx-test-receipts-data-subject-request-linux-final"
```

```bash
# Dogfood command was run through a small stdin Node wrapper that read
# skills/data-subject-request/fixtures/dogfood-erasure-input.json and invoked:
npx -y @runxhq/cli@0.6.14 skill ./skills/data-subject-request --json \
  -R .runx-test-receipts-data-subject-request-dogfood-final \
  --input-json request_packet=<fixture.request_packet> \
  --input-json requestor_proof=<fixture.requestor_proof> \
  --input-json policy=<fixture.policy> \
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
  -e RUNX_RECEIPT_VERIFY_KID=frantic-71-local-harness-key \
  -e RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64=IVL40Zt5HSRFMkLhXy6rbLfP+ntqXtMAl5YOBpiB2xI= \
  node:24-bookworm \
  bash -lc "npx -y @runxhq/cli@0.6.14 verify --receipt-dir .runx-test-receipts-data-subject-request-dogfood-final --json"
```
