---
name: issue-to-pr
description: Govern a scafld-backed issue-to-PR lane with a visible reviewer boundary.
---

# Issue to PR

Drive a bounded issue remediation lane through the full scafld lifecycle under
runx governance, from spec creation through authored fix and adversarial review
to archived completion.

The chain separates cognition from mutation. Agent phases author the scafld
spec, the repo change, and the review contents. Deterministic `fs.write` phases
are the only places files are written to disk. The `scafld` skill then
validates, advances, executes, audits, reviews, and archives the lane with
explicit scopes.

The adversarial review is reviewer-mediated. runx opens the review round via
`scafld review --json`, which returns the review file path and adversarial
prompt. A reviewer (human, controlling agent, or peer agent) fills the three
adversarial sections, `regression_hunt`, `convention_check`, and
`dark_patterns`, then sets a verdict. The review markdown is written via a
deterministic file-write step before `scafld complete` validates it and
archives the spec.

The chain does not control who authors the spec, the fix, or the review. It
provides the governed handoff boundaries. The caller decides.

## Lifecycle

The chain runs: `scafld new` -> author spec -> write spec -> validate -> approve
-> start -> author fix -> write fix -> exec -> audit -> review-open -> reviewer
boundary -> write review -> complete. Each step gets only the scopes it needs.
See `x.yaml` for the full step graph.

## Inputs

- `task_id`: scafld task id (default: `issue-to-pr-fixture`).
- `issue_title`: canonical issue title passed into the lane.
- `title`: compatibility alias for callers that still send `title`.
- `issue_body`: full issue/support body when available.
- `source`: source system, for example `github_issue` or `support_request`.
- `source_id`: source record identifier.
- `source_url`: source URL when available.
- `target_repo`: intended repo slug for repo-local dispatchers.
- `size`: `micro`, `small`, `medium`, or `large` (default: `micro`).
- `risk`: `low`, `medium`, or `high` (default: `low`).
- `phase`: optional scafld execution phase.
- `fixture`: workspace root containing `.ai/`.
- `scafld_bin`: explicit scafld executable path.
