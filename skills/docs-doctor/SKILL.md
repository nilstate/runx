---
name: docs-doctor
description: Find stale product docs by comparing them with the actual surface they describe; emit grounded findings, a coverage map, and a gated docs PR proposal.
runx:
  category: documentation
---

# Docs Doctor

Docs Doctor audits a docs corpus against the actual product surface and the
real user-task matrix. It reads a docs corpus, a `product_surface` fixture
(commands, endpoints, schemas), a `user_task_matrix` of the tasks users
actually try to complete, and a `style_policy`. It emits grounded
`doc_findings`, a `coverage_map`, a `patch_plan`, and a `docs_pr_proposal`.
It never rewrites docs without a proposal and never edits a repository.

## Inputs

- `docs_corpus` (required array): each item is `{page, path, body}` where
  `body` is the doc text actually shipped.
- `product_surface` (required object): `{commands[], endpoints[], schemas[]}`
  describing the surface the docs should describe.
- `user_task_matrix` (required array): each item is `{task, expected_help[]}`
  describing tasks a real user would try and the docs the surface should
  expose to satisfy them.
- `style_policy` (required object): `{tone, voice, max_paragraph_chars,
  required_evidence_in_finding}` — applied to every emitted finding.

## Output

- `doc_findings` (array): each item has `page`, `issue`, `severity`,
  `doc_evidence`, `product_surface_evidence`, and `proposed_fix_scope`.
- `coverage_map` (object): `{covered[], missing[], partial[]}` keyed by
  commands, endpoints, and user tasks.
- `patch_plan` (array): ordered edit units with `target_page`, `change`,
  and `evidence_refs`.
- `docs_pr_proposal` (object): present only when the docs need to change
  and the style policy allows proposing edits.

## Rules

- Cite product-surface evidence for every claim that a doc is stale,
  missing, or partial.
- Refuse to invent coverage: do not claim a doc exists when `docs_corpus`
  contains no entry for the cited page or command.
- Group findings by `severity` ∈ {`blocker`, `warning`, `nit`}.
- The `docs_pr_proposal` is a gated proposal consumed by an issue-to-pr
  executor. This skill does not edit any repository and does not publish.
- Do not echo secrets, customer data, or private identifiers from any
  input into findings or reports.
- When the corpus already matches the surface, emit `coverage_map` with
  no `missing` and skip `docs_pr_proposal` (proposed=false).