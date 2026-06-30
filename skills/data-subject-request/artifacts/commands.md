# data-subject-request Frantic #71 evidence commands

Final package: fengyangxxx/data-subject-request@sha-5e61052d6ca5
Final source/raw URLs: use the exact immutable artifact_refs in the QA-reviewed Frantic payload.
PR: https://github.com/runxhq/runx/pull/192
Receipt: runx:receipt:sha256:261771ae3340aa2439a152f1138b0bbd662fa177fea6da44bd07a6b1505bfde8

```bash
npx -y @runxhq/cli@0.6.14 --version
npx -y @runxhq/cli@0.6.14 registry publish ./skills/data-subject-request/SKILL.md --registry https://api.runx.ai --profile ./skills/data-subject-request/X.yaml --json
npx -y @runxhq/cli@0.6.14 registry read fengyangxxx/data-subject-request@sha-5e61052d6ca5 --registry https://api.runx.ai --json
npx -y @runxhq/cli@0.6.14 add fengyangxxx/data-subject-request@sha-5e61052d6ca5 --registry https://api.runx.ai --to /tmp/runx-clean --json
npx -y @runxhq/cli@0.6.14 harness ./skills/data-subject-request --json -R .runx-test-receipts-data-subject-request-linux-final5
npx -y @runxhq/cli@0.6.14 skill fengyangxxx/data-subject-request@sha-5e61052d6ca5 --registry https://api.runx.ai --json -R .runx-test-receipts-data-subject-request-dogfood-postpublish-fixture --input-json request_packet=<fixtures/dogfood-erasure-input.json.request_packet> --input-json requestor_proof=<fixtures/dogfood-erasure-input.json.requestor_proof> --input-json policy=<fixtures/dogfood-erasure-input.json.policy> -i data_source_ref=<fixture.data_source_ref> -i store_id=<fixture.store_id> -i aggregate_id=<fixture.aggregate_id> -i idempotency_key=<fixture.idempotency_key> --input-json expected_version=<fixture.expected_version>
npx -y @runxhq/cli@0.6.14 verify sha256:261771ae3340aa2439a152f1138b0bbd662fa177fea6da44bd07a6b1505bfde8 --receipt-dir .runx-test-receipts-data-subject-request-dogfood-postpublish-fixture --json
npx -y @runxhq/cli@0.6.14 skill inspect fengyangxxx/data-subject-request@sha-5e61052d6ca5 --registry https://api.runx.ai --json
npx -y @runxhq/cli@0.6.14 doctor --json
```

No Frantic delivery has been submitted from this command log. Final submission still requires an independent QA log ending exactly QA_DECISION: PASS and the guarded Frantic submit wrapper.
