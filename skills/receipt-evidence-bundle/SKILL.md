---
name: receipt-evidence-bundle
description: Build a reviewer-safe evidence bundle from runx receipt references, verification output, and artifact metadata without exposing private payloads.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: review
---

# Receipt Evidence Bundle

Build a reviewer-safe evidence bundle from runx receipts and artifact metadata.

Receipts are useful only when the reviewer can tell what was verified, what was
inferred, what is still missing, and what was redacted. This skill receives one
or more runx receipt refs, optional `runx verify --json` output, and optional
artifact metadata, then emits a compact handoff packet for payout or merge
review. It does not fetch private artifacts, mutate state, or treat a missing
verification record as a passing verdict.

## What this skill does

1. Normalize one or more `runx:receipt:*` refs.
2. Consume caller-supplied verification JSON when present.
3. Separate verified facts from inferred facts and missing evidence.
4. Summarize artifact metadata by URL, digest, kind, and public/private status.
5. Redact private payload hints, tokens, secrets, and raw body fields from the
   reviewer-facing bundle.
6. Return the next reviewer actions needed to approve, reject, or request more
   evidence.

## When to use this skill

Use it when a maintainer, payout reviewer, or merge reviewer needs a concise
evidence packet for a runx-backed delivery. It is appropriate for Frantic
delivery review, PR handoff, receipt audit prep, and any workflow where a human
must compare receipt refs, verification verdicts, artifact links, and redaction
notes before approving work.

## When not to use this skill

Do not use it as a substitute for `runx verify`. The skill can consume verify
output, but it cannot prove a receipt by assertion. Do not use it to fetch
private URLs, scrape private systems, expose raw artifact bodies, summarize
secrets, or approve a payout by itself. If receipt refs are malformed or verify
output is missing for a required gate, it returns a stop decision rather than
inventing proof.

## Procedure

1. Read `receipt_ref` and `receipt_refs`, then normalize them into a unique
   ordered set.
2. Refuse malformed refs. A receipt ref must start with `runx:receipt:`.
3. Read `verification_json` as an object or array. Match verification records
   to receipt refs when the record carries a receipt id or receipt ref.
4. Classify each receipt as verified, failed, or missing verification evidence.
5. Read `artifact_links` as optional metadata only. Preserve public URL, kind,
   digest, and summary fields; never copy private bodies into the bundle.
6. Produce `verified_facts`, `inferred_facts`, `missing_evidence`,
   `reviewer_actions`, and `redactions`.
7. Write `evidence.json` and `report.md` under `output_dir` when requested.

## Edge cases and stop conditions

- **No receipt refs:** return `needs_more_evidence`; a bundle without a receipt
  cannot support payout or merge review.
- **Malformed receipt ref:** return `refused`; do not normalize arbitrary strings
  into receipt refs.
- **Missing verify output:** include `missing_evidence` and a reviewer action to
  run `runx verify --receipt <receipt.json> --json`.
- **Failed verify output:** keep the verdict in `verified_facts`, but set the
  bundle decision to `needs_review` and ask the reviewer to resolve the failed
  proof before approving.
- **Private or secret-bearing artifacts:** preserve a digest or redaction note
  only. Raw payloads, tokens, passwords, API keys, cookies, and private bodies
  are redacted.

## Output schema

The primary output is `receipt_evidence_bundle`:

```yaml
schema: runx.receipt_evidence_bundle.v1
decision: ready | needs_more_evidence | needs_review | refused
reviewer_context: string
receipt_refs:
  - string
verified_facts:
  - receipt_ref: string
    fact: string
    evidence: string
inferred_facts:
  - fact: string
    basis: string
missing_evidence:
  - item: string
    reason: string
reviewer_actions:
  - action: string
    reason: string
redactions:
  - field: string
    reason: string
artifacts:
  - kind: string
    url: string
    digest: string
    public: boolean
summary:
  receipts_total: number
  receipts_verified: number
  artifacts_total: number
  redactions_total: number
```

The same object is returned as `evidence_json`. When `output_dir` is set, the
runner writes `evidence.json` and a reviewer-facing `report.md`.

## Worked example

```bash
runx skill "$PWD/skills/receipt-evidence-bundle" \
  --input receipt_ref=runx:receipt:sha256:abc123 \
  --input verification_json='{"receipt_ref":"runx:receipt:sha256:abc123","verdict":"pass","signature_valid":true}' \
  --input artifact_links='[{"kind":"report","url":"https://example.com/report.md","sha256":"abc123","public":true}]' \
  --input reviewer_context="Frantic payout review" \
  --input output_dir=artifacts/valid-receipt \
  --json
```

The output has a `ready` decision, one verified receipt fact, public artifact
metadata, no missing verification evidence, and no raw private payload.

## Inputs

- `receipt_ref`: one runx receipt reference.
- `receipt_refs`: array of runx receipt references.
- `verification_json`: runx verify output or an array of verify records.
- `artifact_links`: optional public artifact metadata.
- `reviewer_context`: review purpose or gate.
- `output_dir`: optional package-local artifact output directory.

## Outputs

- `receipt_evidence_bundle`: complete reviewer packet.
- `evidence_json`: same packet as machine-checkable JSON.
- `report_md`: concise Markdown report for human review.
