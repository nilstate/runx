# access-request-review delivery report

- Package: `lubuseb/access-request-review@sha-fefdaf21eb13`.
- Public registry URL: `https://runx.ai/x/lubuseb/access-request-review@sha-fefdaf21eb13`.
- Source PR: `https://github.com/runxhq/runx/pull/123`.
- `runx-cli 0.6.13` was used for publish, registry read, clean install, harness, dogfood, and receipt verification.
- Local harness passed three cases: `least-privilege-grant-proposal`, `deny-for-disallowed-resource`, and `missing-justification-fails-closed`.
- Hosted clean install succeeded with `runx add lubuseb/access-request-review@sha-fefdaf21eb13 --registry https://api.runx.ai`.
- Harness from the clean installed package passed the same three cases and all hosted harness receipts verified.
- Hosted dogfood produced sealed receipt `runx:receipt:sha256:db7a0c11abce65a3b0561308d75b46db38b4e36598021534b6f268343863ea21`.
- `runx verify` returned `valid=true` and no findings for the dogfood receipt.
- The runner emits a bounded `one_time_grant_proposal` only when the request matches role, action, resource, scope prefix, TTL, and approval-gate policy.
- The implementation is read-only: it reads the provided JSON request, policy, and entitlements, computes deterministically in memory, requires no credentials, performs no network/provider calls, and emits structured stdout.

Reproduce:

```bash
runx add lubuseb/access-request-review@sha-fefdaf21eb13 --registry https://api.runx.ai
runx registry read lubuseb/access-request-review@sha-fefdaf21eb13 --registry https://api.runx.ai --json
runx harness ./access-request-review --json
runx skill lubuseb/access-request-review@sha-fefdaf21eb13 --registry https://api.runx.ai --input-json access_request='<bounded request>' --input-json policy='<policy>' --input-json current_entitlements='<entitlements>' --json
runx verify --receipt-dir /tmp/runx-access-request-review-hosted-dogfood-receipts --json
```
