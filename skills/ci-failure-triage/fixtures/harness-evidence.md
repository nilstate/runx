# ci-failure-triage Harness Evidence

Validated locally with the published `runx` CLI required by Frantic.

```bash
pnpm dlx @runxhq/cli@0.6.13 --version
```

Output:

```text
runx-cli 0.6.13
```

Harness command:

```bash
RUNX_RECEIPT_SIGN_KID=ci-failure-triage-test-key \
RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64=<redacted test seed> \
RUNX_RECEIPT_SIGN_ISSUER_TYPE=hosted \
pnpm dlx @runxhq/cli@0.6.13 harness ./skills/ci-failure-triage --json
```

Result:

```json
{
  "status": "passed",
  "case_count": 2,
  "assertion_error_count": 0,
  "assertion_errors": [],
  "case_names": [
    "real_break_clear_logs",
    "ambiguous_truncated_logs"
  ],
  "receipt_ids": [
    "sha256:7755badf3297aa9402481ba47575a580c8ab76833acb04e273b1fd6352f4e727"
  ],
  "graph_case_count": 0
}
```
