# code-review-note delivery report

This delivery implements and publishes the requested `code-review-note` runx skill for bounty #59.

## Package

- Owner: `vidshidden`
- Package: `code-review-note`
- Version: `sha-d4b7c3ff5357`
- Registry ref: `vidshidden/code-review-note@sha-d4b7c3ff5357`
- Public URL: https://runx.ai/x/vidshidden/code-review-note@sha-d4b7c3ff5357
- Source URL: https://github.com/VidsHidden/runx/tree/code-review-note/skills/code-review-note
- PR URL: https://github.com/runxhq/runx/pull/121
- Raw X.yaml: https://raw.githubusercontent.com/VidsHidden/runx/code-review-note/skills/code-review-note/X.yaml
- Raw SKILL.md: https://raw.githubusercontent.com/VidsHidden/runx/code-review-note/skills/code-review-note/SKILL.md
- Verification JSON: see submitted `verification_json`
- Dogfood receipt: `runx:receipt:sha256:45bc3b4f9d30d422339fbbe0df95e15ddb1ebf6d919500e6826c033c7e39020f`
- Dogfood receipt URL: https://raw.githubusercontent.com/VidsHidden/runx/code-review-note/skills/code-review-note/evidence/dogfood-receipt-sha256-45bc3b4f9d30d422339fbbe0df95e15ddb1ebf6d919500e6826c033c7e39020f.json
- Dogfood verify public key: https://raw.githubusercontent.com/VidsHidden/runx/code-review-note/skills/code-review-note/evidence/dogfood-receipt-public-key.txt

## What it does

- Reads a bounded `pr_diff` and optional `context`.
- Emits `findings[]`, `risk`, `test_gaps[]`, and `review_note`.
- Grounds findings in supplied diff paths and changed lines.
- Refuses empty or unparseable diffs instead of inventing review findings.
- Proposes a gated review-note Effect for the existing `pr-review-note` catalog skill.
- Does not fetch repositories, post comments, approve, request changes, push, or merge.

## Harness and dogfood evidence

- runx version: `runx-cli 0.6.13`
- Local harness command: `runx harness ./skills/code-review-note --receipt-dir <isolated-receipt-dir> --json`
- Local harness status: `passed`
- Hosted harness status: `passed`
- Harness cases: `risky-diff-yields-review-note, empty-diff-refused`
- Dogfood receipt ref: `runx:receipt:sha256:45bc3b4f9d30d422339fbbe0df95e15ddb1ebf6d919500e6826c033c7e39020f`
- Dogfood receipt URL: https://raw.githubusercontent.com/VidsHidden/runx/code-review-note/skills/code-review-note/evidence/dogfood-receipt-sha256-45bc3b4f9d30d422339fbbe0df95e15ddb1ebf6d919500e6826c033c7e39020f.json
- Dogfood verify public key: https://raw.githubusercontent.com/VidsHidden/runx/code-review-note/skills/code-review-note/evidence/dogfood-receipt-public-key.txt
- Dogfood verify verdict: `runx verify --receipt dogfood-receipts/sha256:45bc3b4f9d30d422339fbbe0df95e15ddb1ebf6d919500e6826c033c7e39020f.json --json returned valid: true with valid digest, valid content_address, and valid production signature for kid runx-demo-key`
- Harness evidence: https://runx.ai/x/vidshidden/code-review-note#harness

The sealed case produces four grounded findings for a risky refund diff, a high risk rating, two named test gaps, and a proposed review note. The refused case stops on an empty diff. The submitted dogfood receipt is a standalone post-publish dogfood receipt and is distinct from the hosted harness receipt ids.

## Install and run

```bash
runx add vidshidden/code-review-note@sha-d4b7c3ff5357 --registry https://api.runx.ai
runx skill vidshidden/code-review-note@sha-d4b7c3ff5357 --registry https://api.runx.ai --json
runx verify --receipt <receipt.json> --json
```

## Why a user would trust it

- The package name, registry ref, PR files, raw artifacts, evidence, and report all describe `code-review-note@sha-d4b7c3ff5357`.
- The hosted registry harness passed after publish.
- The skill is read-only and mutation-free.
- The review note is explicitly gated; posting requires `pr.comment` authority through `pr-review-note`.
- Merge scope is refused and out of scope.
- The refusal path prevents low-evidence or empty diffs from producing fake confidence.
