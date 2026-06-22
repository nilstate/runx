# least-privilege-plan delivery report

- Package: `lubuseb/least-privilege-plan@sha-2ed0e113ff52`.
- Public registry URL: `https://runx.ai/x/lubuseb/least-privilege-plan@sha-2ed0e113ff52`.
- Source PR: `https://github.com/runxhq/runx/pull/118`.
- `runx-cli 0.6.13` was used for publish, registry read, clean install, harness, dogfood, and receipt verification.
- Local harness passed five cases: `over-broad-grant-plan`, `justified-grant-plan`, `missing-grants-fails-closed`, `invalid-effect-status-fails-closed`, and `policy-mismatch-fails-closed`.
- Hosted clean install succeeded with `runx add lubuseb/least-privilege-plan@sha-2ed0e113ff52 --registry https://api.runx.ai`.
- Harness from the clean installed package passed the same five cases and all harness receipts verified.
- Hosted dogfood produced sealed receipt `runx:receipt:sha256:434a5446b2f7d85b35a2ff9ec70ba48d25c8bf06b8cb64f0f79ff4a576f33d77`.
- `runx verify` returned `valid=true` and no findings for the dogfood receipt.
- The runner emits `keep`, `reduce`, `revoke`, and `needs_human_review` recommendations with exact observed effects, policy refs, unused scopes, or missing evidence.
- The implementation is read-only: it reads the provided JSON packet and policy, computes recommendations in memory, requires no credentials, performs no network/provider calls, and emits structured stdout.

Reproduce:

```bash
runx add lubuseb/least-privilege-plan@sha-2ed0e113ff52 --registry https://api.runx.ai
runx registry read lubuseb/least-privilege-plan@sha-2ed0e113ff52 --registry https://api.runx.ai --json
runx harness ./least-privilege-plan --json
runx skill lubuseb/least-privilege-plan@sha-2ed0e113ff52 --registry https://api.runx.ai --input-json run_history_packet='<bounded packet>' --input-json policy='<declared policy>' --json
runx verify --receipt-dir /tmp/runx-least-privilege-plan-hosted-dogfood-receipts --json
```
