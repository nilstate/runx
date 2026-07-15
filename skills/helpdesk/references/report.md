# Support Triage Reply Dogfood Report

## Result

`helpdesk` is published as:

- Registry ref: `godfood/helpdesk@<version>`
- Public page: https://runx.ai/x/godfood/helpdesk
- Source: https://github.com/runxhq/runx/tree/main/skills/helpdesk
- Digest and profile digest: resolve with
  `runx registry read godfood/helpdesk@<version> --registry https://api.runx.ai --json`
- Trust tier: `community`

The skill is intentionally generic. Product-specific support-ops skills can
compose it, but this public artifact does not include private product policy,
credentials, customer data, or mutation paths.

## What It Does

The skill accepts one bounded `support_request` and optional `policy`, then
returns:

- `classification`
- `severity`
- `confidence`
- `recommended_path`
- `evidence`
- `draft_email`
- `send_gate`

The skill never sends email, posts comments, mutates accounts, opens issues, or
touches billing. A reply draft is only a proposal; `send_gate.status` remains
`requires_human_approval`.

## Verification

Local harness:

```sh
runx harness skills/helpdesk --receipt-dir "$tmp_receipts" --json
```

Result: passed, 3 cases:

- `safe-how-to-reply-draft`
- `account-access-escalates-without-draft`
- `missing-request-fails`

Clean install:

```sh
runx add godfood/helpdesk@<version> \
  --registry https://api.runx.ai \
  --json
```

Result: installed.

Dogfood execution:

```sh
runx skill godfood/helpdesk@<version> \
  --registry https://api.runx.ai \
  --input 'support_request=<json>' \
  --input 'policy=<json>' \
  --receipts <dir> \
  --json
```

Output summary:

- Receipt: see `evidence.json` and `dogfood-receipt.json`
- Classification: `how_to`
- Severity: `low`
- Confidence: `0.88`
- Recommended path: `reply_draft`
- Send gate: `requires_human_approval`

Draft excerpt from the dogfood run:

```text
Hi Mira,

Thanks for the note. You asked about How do I verify my sending domain?.

For sending-domain verification, check that the DNS records shown in the setup are published exactly, then run the domain verification check again after DNS propagation. If a record still fails, compare the host/name and value fields character for character, including whether your DNS provider automatically appends the root domain.

Before sending, an operator should confirm the product state and any account-specific details. This draft has not been sent.

Thanks,
ExampleDesk Support
```

Receipt verification:

```sh
runx verify --receipt dogfood-receipt.json --json
```

Result: valid.

Hosted control admission was also exercised as `godfood`:

- Run: `hr_7f1f591110f9458295eefe13f1d25e8b`
- URL: https://runx.ai/r/hr_7f1f591110f9458295eefe13f1d25e8b
- Observed state: `pending`

The hosted worker did not drain during the verification window, so the execution
proof for this delivery is the registry-resolved local receipt above. Temporary
`godfood` publish/run credentials used for this dogfood pass were revoked after
use.

## Review Value

This is review-worthy because it converts a common, real operator workflow into
a reusable governed skill:

- It distinguishes safe support replies from account, billing, abuse, bug, and
  unknown cases.
- It returns explicit evidence and missing context instead of pretending to know
  private account state.
- It gives a human a sendable draft when appropriate, but never finalizes a send.
- It is public, installable, source-backed, and receipt-backed.

This is not a throwaway deployment. It is a reusable ops skill with a registry
entry, harness, typed runner, and public source.
