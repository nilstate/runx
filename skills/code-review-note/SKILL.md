---
name: code-review-note
description: Turn a bounded PR diff into grounded review findings, risk, test gaps, and a gated review-note proposal.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  tags:
    - code-review
    - pull-request
    - risk
links:
  catalog_pair: pr-review-note
---

# Code Review Note

This skill reads a bounded pull-request diff plus optional review context and
produces a structured review packet. It does not fetch repositories, post
comments, push commits, approve pull requests, request changes, or merge. The
only proposed side effect is a gated `review_note` that can be handed to the
`pr-review-note` catalog skill when a caller has admitted comment scope.

## When to use

Use this skill when a reviewer needs a concise, reproducible review note for a
provided diff. It is designed for coding-agent review handoff, release review,
and PR triage where the reviewer must name risk, reproduction, and missing tests
without inventing code paths outside the supplied patch.

## Inputs

- `pr_diff`: a unified diff or bounded diff excerpt.
- `context`: optional JSON or string with repository, PR number, title, test
  policy, and reviewer instructions.

## Output

The skill emits `code_review_note_packet.v1`:

- `findings[]`: grounded review findings with severity, file, evidence,
  reproduction steps, and source lines.
- `risk`: overall risk level and rationale.
- `test_gaps[]`: named missing or weak tests tied to the diff.
- `review_note`: a gated proposed Effect containing the comment body and the
  catalog skill that may post it.
- `refusal`: present only when the diff is empty or unparseable.

## Procedure

1. Parse the supplied diff into changed files and added/removed lines.
2. Refuse empty or unparseable diffs instead of guessing.
3. Look for concrete risk signals visible in the diff:
   - authentication, authorization, payment, filesystem, network, or secret
     handling changes
   - removed validation or removed error handling
   - broad catch blocks, unchecked parsing, or TODO markers in new logic
   - test files missing while behavior files change
4. Build findings only from visible changed lines and file paths.
5. Produce a risk summary and named test gaps.
6. Render a review note suitable for the `pr-review-note` catalog skill, but do
   not post it.

## Safety boundaries

The skill is read-only. It refuses to claim knowledge of code outside the
provided diff. It does not run tests, install dependencies, call GitHub, or infer
private repository state. If the diff is too small to support a claim, it says
so and emits a low-risk note rather than inventing a blocker.

The `review_note` is a proposed Effect, not an executed GitHub comment. Posting
requires a separate authority gate through `pr-review-note` with comment scope.
Merge scope is explicitly outside this skill.
