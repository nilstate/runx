# Harness evidence

Output of a local `runx harness ./skills/postmortem-maker` run (runx-cli
0.6.14) against this exact package revision:

- `harness-output.json` — the harness summary: `status: passed`, 3/3 cases
  (`consistent-evidence-yields-proposal`, `ambiguous-evidence-withholds-proposal`,
  `refuses-without-policy-or-evidence`), 0 assertion errors.
- `receipts/` — the three sealed/failure-case receipts (`runx.receipt.v1`)
  produced by that run, signed with a throwaway CI-issuer key generated for
  the run and discarded afterwards.

Regenerate with:

```bash
RUNX_RECEIPT_SIGN_KID=<kid> \
RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64=<base64 of a raw 32-byte seed> \
RUNX_RECEIPT_SIGN_ISSUER_TYPE=ci \
runx harness ./skills/postmortem-maker --receipt-dir "$(mktemp -d)"
```

Note: the local harness matcher enforces each case's `expect.status`
(sealed/failure); the richer `expect.output` blocks in `X.yaml` pin the
documented output contract (`postmortem.status`, `root_cause.status`,
`publish_proposal`, `summary.unknown_count`, `summary.action_item_count`) and
are verified to match the actual case outputs exactly.
