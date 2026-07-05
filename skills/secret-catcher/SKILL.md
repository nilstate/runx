---
name: secret-catcher
description: Scan a code diff for credential-like spans and emit redacted findings, a gated redaction proposal, and a block decision without ever quoting a raw secret.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  tags:
    - security
    - secrets
    - diff
links:
  source: https://github.com/epistemedeus/secret-catcher
---

## What this skill does

This skill reads a unified diff and detects credential-like spans that a change
would introduce. It scans only added lines, reports each match as a finding
located by file, line, and column, proposes a redaction that a downstream
executor can perform, and returns a `block` decision. A change that adds a
credential blocks; a clean change does not.

The skill is read-only and offline. It makes no network calls, installs
nothing, executes no caller-supplied code, and edits no files. It never quotes a
raw secret: every finding carries a redacted preview and a one-way SHA-256
fingerprint instead of the matched value, and the runner fails closed rather
than emit output in which a raw value could appear.

## When to use this skill

Use this skill on a pull-request or pre-commit diff to catch a leaked
credential before it lands. It is appropriate as a gate in an agent or CI
pipeline that must decide whether a diff is safe to merge, and as the evidence
step before a human or a downstream redaction executor acts. It produces a
machine-checkable packet plus a concise Markdown report for reviewer handoff.

## When not to use this skill

Do not use this skill as a full application security review, an entropy scanner
over an entire repository history, or a guarantee that a diff is secret-free.
Coverage is bounded by the detector set and the contents of the supplied diff. A
zero-finding result means only that no configured detector matched an added line
under the current rules.

Do not use it to remove or rewrite secrets. Redaction is proposed here and
performed by the gated `redact-pii` executor; this skill never edits content.

## Procedure

1. Read the `diff` input (or `diff_path` for a diff stored inside the skill
   directory) and record its byte length and SHA-256.
2. Walk the unified diff, tracking the current file and the new-file line number
   from each `+++` header and `@@` hunk header.
3. On each added line, run every detector and record a finding with its type,
   `{ file, line, column }` location, a redacted preview, and a fingerprint.
4. Exclude placeholders, template interpolations, and environment-variable
   references so ordinary configuration does not false-block.
5. Build a gated `redaction_proposal` for the `redact-pii` executor when any
   finding exists.
6. Set `block` to true when there is at least one finding.
7. Verify no raw secret value appears anywhere in the output; fail closed if it
   would.
8. Emit `secret.catcher.result.v1` and, when `output_dir` is set, write
   `evidence.json` and `report.md`.

## Edge cases and stop conditions

Stop with an error when neither `diff` nor `diff_path` is provided, when
`diff_path` resolves outside the skill directory, or when the diff exceeds the
size limit. An empty diff or a diff with no added lines is a valid clean result:
zero findings and `block: false`.

Removed lines and context lines are never scanned, so deleting a secret does not
produce a finding. Findings are grounded only in added lines of the supplied
diff; the skill never infers a secret that is not literally present.

The redaction proposal is a proposed effect only. Any real edit, commit, or push
needs its own authority gate and receipt through the `redact-pii` executor.

## Output schema

The primary output is `secret_catcher_result`, with schema
`secret.catcher.result.v1`:

```json
{
  "schema": "secret.catcher.result.v1",
  "skill": "secret-catcher",
  "version": "0.1.0",
  "block": true,
  "findings": [
    {
      "type": "aws_access_key_id",
      "location": { "file": "config/prod.env", "line": 2, "column": 19 },
      "redacted_preview": "AKIA************…",
      "value_length": 20,
      "fingerprint": "sha256:1a5d44a2dca19669"
    }
  ],
  "redaction_proposal": {
    "decision": "proposed",
    "performed_by": "redact-pii",
    "requires_approval": true,
    "edits": [
      {
        "file": "config/prod.env",
        "line": 2,
        "column_start": 19,
        "column_end": 39,
        "replacement": "***REDACTED_AWS_ACCESS_KEY_ID***"
      }
    ],
    "note": "Proposal only. secret-catcher edits no files and scrubs no live content. The redact-pii executor performs the gated edit after approval."
  },
  "summary": {
    "added_lines_scanned": 4,
    "files_scanned": 1,
    "findings": 1,
    "finding_types": ["aws_access_key_id"]
  },
  "policy": {
    "scans": "added diff lines only",
    "grounded_in": "diff",
    "edits_files": false,
    "quotes_raw_secrets": false,
    "downstream_executor": "redact-pii",
    "detectors": ["aws_access_key_id", "aws_secret_access_key", "github_personal_access_token", "slack_token", "google_api_key", "stripe_secret_key", "private_key_block", "json_web_token", "generic_secret_assignment"]
  },
  "source": { "kind": "diff", "bytes": 0, "sha256": "hex" },
  "validation": {
    "grounded_in_diff": true,
    "every_finding_has_location": true,
    "block_iff_findings": true,
    "raw_secret_values_absent": true,
    "finding_rule": "..."
  }
}
```

When `output_dir` is provided, the runner also writes `evidence.json` and
`report.md` inside that directory.

## Worked example

The harness scans a diff that adds a production env file containing AWS's
documented example credentials and a synthetic token:

```bash
runx skill "$PWD" \
  --input-json diff='"diff --git a/config/prod.env b/config/prod.env\n--- /dev/null\n+++ b/config/prod.env\n@@ -0,0 +1,2 @@\n+AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n"' \
  --json
```

Expected result shape:

- `block` is true.
- `findings[0].type` is `aws_access_key_id` and its location points at the added
  line and column.
- `findings[0].redacted_preview` masks the value and `findings[0].fingerprint`
  is a truncated SHA-256; the raw key never appears.
- `redaction_proposal.performed_by` is `redact-pii` and `requires_approval` is
  true.

Swapping in a diff that only references `process.env.API_KEY` yields zero
findings and `block: false`.

## Inputs

- `diff`: the unified diff to scan (required).
- `scan_context`: optional metadata recorded with the result.
- `diff_path`: optional path to a diff file inside the skill directory.
- `output_dir`: optional directory for `evidence.json` and `report.md`.

## Outputs

- `secret_catcher_result`: the complete packet.
- `block`: boolean merge gate, true when any finding exists.
- `findings`: array of `{ type, location, redacted_preview, value_length, fingerprint }`.
- `redaction_proposal`: gated proposal consumed by the `redact-pii` executor.
