# least-privilege-plan delivery report

- Package: `lubuseb/least-privilege-plan@sha-e2d0eec62745`.
- Public registry URL: `https://runx.ai/x/lubuseb/least-privilege-plan@sha-e2d0eec62745`.
- Source PR: `https://github.com/runxhq/runx/pull/118`.
- `runx-cli 0.6.13` was used for publish, registry read, clean install, harness, dogfood, and receipt verification.
- Local harness passed three cases: `over-broad-grant-plan`, `justified-grant-plan`, and `missing-grants-fails-closed`.
- Hosted clean install succeeded with `runx add lubuseb/least-privilege-plan@sha-e2d0eec62745 --registry https://api.runx.ai`.
- Harness from the clean installed package passed the same three cases and all harness receipts verified.
- Hosted dogfood produced sealed receipt `runx:receipt:sha256:fd396e6bf878658a9d3c745a5c4d228c95bc6c45008a298cb2bbe2d2f2b13d5f`.
- `runx verify` returned `valid=true` and no findings for the dogfood receipt.
- The runner emits `keep`, `reduce`, `revoke`, and `needs_human_review` recommendations with exact observed effects, policy refs, unused scopes, or missing evidence.
- The implementation is read-only: it reads the provided JSON packet and policy, computes recommendations in memory, requires no credentials, performs no network/provider calls, and emits structured stdout.

Reproduce:

```bash
runx add lubuseb/least-privilege-plan@sha-e2d0eec62745 --registry https://api.runx.ai
runx registry read lubuseb/least-privilege-plan@sha-e2d0eec62745 --registry https://api.runx.ai --json
runx harness ./least-privilege-plan --json
runx skill lubuseb/least-privilege-plan@sha-e2d0eec62745 --registry https://api.runx.ai --input-json run_history_packet='<bounded packet>' --input-json policy='<declared policy>' --json
runx verify --receipt-dir /tmp/runx-least-privilege-plan-hosted-dogfood-receipts --json
```
