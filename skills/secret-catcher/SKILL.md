---
name: secret-catcher
version: 0.1.0
description: Inspect a bounded code diff for credential-like spans, report only redacted finding metadata, and propose a gated redaction without editing files.
links:
  source: https://github.com/runxhq/runx/tree/main/skills/secret-catcher
runx:
  category: security
  input_resolution:
    required:
      - diff
---

## What this skill does

`secret-catcher` scans the added lines of a supplied code diff for common
credential shapes and suspicious secret assignments. It emits finding types and
locations, a block decision, and a gated redaction proposal. Raw matched values
never appear in output, logs, or receipt artifacts.

The skill is read-only. It does not edit the repository, rotate credentials,
push commits, or invoke a downstream redaction tool.

## Inputs

- `diff` (required): a bounded unified diff to inspect.
- `scan_context` (optional): non-secret repository or pull-request metadata.

## Output

- `findings[]`: `{type, location}` records grounded in added diff lines.
- `redaction_proposal`: a gated proposal naming affected locations, or `null`.
- `block`: `true` when one or more credential-like spans are found.

## Detection and safety rules

1. Inspect added lines only; ignore diff headers.
2. Detect private-key headers, common provider token prefixes, bearer tokens,
   and secret-like assignments with credential-shaped values.
3. Report the diff line number and finding type, never the matched value.
4. Deduplicate findings at the same location and type.
5. Do not block a clean diff merely because it contains words such as
   `token`, `secret`, or `password` in documentation or variable names.
6. Emit a proposal only. A separately authorized `redact-pii` run may consume
   the proposal, but this skill performs no mutation.

## Example

```bash
runx skill ./skills/secret-catcher \
  --input diff="$(cat change.diff)" \
  --input-json scan_context='{"repository":"example/project","pull_request":42}' \
  --json
```

Verify the resulting receipt with `runx verify --receipt <receipt.json> --json`.

