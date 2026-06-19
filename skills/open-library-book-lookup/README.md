# Open Library Book Lookup Connector

Frantic #4 deliverable for `p-2fe96b012e`.

This package defines a runx connector skill for the Open Library public search
API. It includes:

- `SKILL.md`
- `X.yaml`
- declared connector dependency, scopes, policy, and emits
- `open_library.search` governed action with typed inputs and typed output
- deterministic harness fixture
- captured passing harness receipt output
- resolvable receipt store under `receipts/`
- receipt verification output

Reproduce locally:

```powershell
$env:RUNX_RECEIPT_SIGN_KID='open-library-book-lookup-test-key'
$env:RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64='<local test signing seed>'
$env:RUNX_RECEIPT_SIGN_ISSUER_TYPE='hosted'
runx harness . --receipt-dir .\receipts --json
```

Current receipt evidence:

- Harness output: `harness-patched-signed-output.json`
- Root receipt: `sha256:536d5dcce1df9850fd7a057412873b2a336d3aa7d7c1d89bc4dc2ce9de6f4c17`
- Receipt store index: `receipts/index.json`
- Verification output: `receipt-verify-output.json`

The local test signing seed is not checked in. The public verification key used
for `receipt-verify-output.json` is:

```powershell
$env:RUNX_RECEIPT_VERIFY_KID='open-library-book-lookup-test-key'
$env:RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64='IVL40Zt5HSRFMkLhXy6rbLfP+ntqXtMAl5YOBpiB2xI='
runx verify 'sha256:536d5dcce1df9850fd7a057412873b2a336d3aa7d7c1d89bc4dc2ce9de6f4c17' --receipt-dir .\receipts --json
```
