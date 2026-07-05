---
name: launch-guard
version: 0.1.0
description: Gate a release candidate with policy-grounded checks and emit either a release proposal or a no-go decision with blockers.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/zdfgu113/runx/tree/codex/launch-guard-81/skills/launch-guard
runx:
  category: code
  input_resolution:
    required:
      - release_candidate
      - launch_policy
---

# Launch Guard

Launch Guard gives release owners a sealed go/no-go decision before anything
ships. It reads a release candidate, launch policy, test results, rollback
plan, observability plan, and changelog, then emits a readiness report and
either a gated `release_proposal` for the `release` skill or a `no_go` decision
with blockers.

It never deploys, tags, publishes, or announces a release.

## Procedure

1. Require `release_candidate` and `launch_policy`.
2. Check every `launch_policy.required_checks[]` against
   `release_candidate.test_results[]`.
3. Count open risks from `release_candidate.risks[]` and compare them with
   `launch_policy.max_open_risk`.
4. When `launch_policy.rollback_required` is true, require a tested rollback
   plan with at least one step.
5. Require observability dashboards and alerts.
6. Require at least one changelog entry.
7. Emit `decision="go"` with a `release_proposal` only when there are no
   blockers.
8. Emit `decision="no_go"` with exact blockers and no `release_proposal` when
   any check fails.

## Inputs

- `release_candidate.version`: proposed version.
- `release_candidate.diff_ref`: commit range, compare URL, or source revision.
- `release_candidate.test_results[]`: named checks with `status` and `source`.
- `release_candidate.rollback_plan`: `{ tested, steps[] }`.
- `release_candidate.observability_plan`: `{ dashboards[], alerts[] }`.
- `release_candidate.changelog.entries[]`: user-facing changes.
- `launch_policy.required_checks[]`: check names that must pass.
- `launch_policy.max_open_risk`: maximum allowed open risk count.
- `launch_policy.rollback_required`: whether a tested rollback plan is required.

## Output

- `decision`: `go` or `no_go`.
- `readiness_report`: grounded checks, risks, and blockers.
- `release_proposal`: gated proposal for the `release` skill when `decision` is
  `go`; `null` when blocked.

## Example

```bash
runx skill ./skills/launch-guard \
  --input-json release_candidate="$(cat skills/launch-guard/fixtures/go-release.json)" \
  --input-json launch_policy='{"required_checks":["unit","integration","security"],"max_open_risk":0,"rollback_required":true}' \
  --json
```
