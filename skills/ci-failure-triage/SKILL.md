---
name: ci-failure-triage
description: Classify CI failures from logs, commit context, and repo state, then emit a read-only routing packet.
runx:
  category: code
  tags:
    - ci
    - triage
    - maintenance
---

# CI Failure Triage

Classify a CI failure as `flake`, `infra`, `real-break`, or `dep` using only
the supplied CI logs, commit context, repo state, and repository configuration.
Emit a typed `runx.ci.triage.v1` packet that helps a downstream lane decide the
next governed step.

This skill is read-only. It never reruns CI, opens or edits a tracking item,
pages an operator, files an issue, comments on a PR, or claims that another rail
has consumed its output. It produces a classification and exactly one read-only
recommendation when the evidence clears the requested confidence threshold.

## Quality Profile

- Purpose: make the first CI incident decision faster without mutating the repo
  or turning thin evidence into a fake root cause.
- Audience: maintainers, release owners, and downstream runx lanes such as
  `issue-intake`, `issue-to-pr`, and `pr-review-note`.
- Artifact contract: emit `classification{verdict,confidence,evidence_refs}`
  and exactly one of `rerun_verdict`, `page_note`, or `routing_decision`.
- Evidence bar: every verdict must cite concrete log lines, commit facts, or
  repo-state facts from the input. Missing logs, truncated output, unknown base
  status, or conflicting signals must be named as blockers.
- Voice bar: concise maintainer triage, with the decision first and the reason
  tied to evidence. Do not sound like a generic incident template.
- Strategic bar: route only the next governed step. For flake and infra, keep
  the recommendation read-only. For `real-break` or `dep`, recommend a
  downstream lane such as `issue-to-pr` only when the failure is grounded.
- Stop conditions: return `needs_agent` when logs are truncated, the root cause
  is not visible, confidence is below `escalation_policy.min_confidence`, the
  caller asks for a mutating action, or the requested classification is outside
  the supported verdict set.

## Inputs

- `ci_failure`: object containing:
  - `logs`: CI output text or structured log excerpts.
  - `commit`: commit identifier, message, and changed files or patch summary.
  - `repo_state`: branch, base branch, latest known base status, prior runs, and
    any relevant queue state.
- `repo_config`: object containing CI provider, lane names, and repository
  routing vocabulary.
- `escalation_policy`: object containing `min_confidence` and any operator
  escalation constraints.

## Output

Emit a `runx.ci.triage.v1` packet:

```json
{
  "classification": {
    "verdict": "flake | infra | real-break | dep",
    "confidence": 0.0,
    "evidence_refs": ["logs:...", "commit:..."]
  },
  "rerun_verdict": null,
  "page_note": null,
  "routing_decision": null,
  "escalation": null,
  "refusal": null,
  "handoff": {
    "downstream_lanes": ["issue-intake", "issue-to-pr", "pr-review-note"],
    "dispatch_rule": "Dispatch by naming only. A separate governed run admits any downstream action."
  },
  "safeguards": {
    "mutating_actions_taken": [],
    "disallowed_actions": ["open_tracking_item", "rerun_ci", "page_operator"]
  }
}
```

Exactly one action field must be non-null when the run seals:

- `rerun_verdict`: for a likely flake. This is only a read-only verdict that a
  separate operator or lane may use. It is not a CI rerun.
- `page_note`: for likely infrastructure failure. This is only a read-only note
  for a downstream operator lane. It is not an operator page.
- `routing_decision`: for `real-break` or `dep`, with
  `{ "recommended_lane": "issue-to-pr", "rationale": "..." }` or another named
  lane from `repo_config`.

When evidence is too weak, emit no routing field and stop at `needs_agent`.

## Procedure

1. Normalize the CI logs into named evidence snippets. Preserve enough text to
   support each claim without copying the whole log.
2. Compare the failure to the commit facts and repo state.
3. Choose the lowest-risk supported verdict:
   - `flake`: intermittent or retry-shaped failure with no commit-local cause.
   - `infra`: runner, network, registry, quota, or service failure not caused by
     the code under test.
   - `real-break`: deterministic failure tied to the supplied commit or repo
     state.
   - `dep`: dependency resolution, lockfile, registry metadata, or incompatible
     external package change.
4. Assign confidence. Confidence must be below threshold when logs are
   truncated, the base status is unknown, or evidence conflicts.
5. If confidence is below `escalation_policy.min_confidence`, return
   `needs_agent` with the missing evidence and no routing decision.
6. If confidence clears the threshold, emit `classification` and exactly one
   read-only recommendation field.
7. Record the handoff seam: downstream issue intake, PR authoring, review note,
   CI rerun, or paging must happen in a separate governed run.

## Refusals And Stops

Return `needs_agent` or `refused` instead of sealing when:

- The logs are too short, truncated, or missing the failing command.
- The caller asks the skill to rerun CI, open an issue, page a person, merge a
  PR, alter code, or mutate provider state.
- The requested verdict is not one of `flake`, `infra`, `real-break`, or `dep`.
- The claim depends on a root cause that is not visible in the supplied inputs.
- The classification confidence would be below
  `escalation_policy.min_confidence`.

## Harness Cases

- `real_break_clear_logs`: sealed happy case. Clear test output and a matching
  commit change produce `classification.verdict = real-break` with
  `routing_decision.recommended_lane = issue-to-pr`.
- `ambiguous_truncated_logs`: stop case. Truncated logs and unknown base status
  do not support a confident verdict, so the run blocks at `needs_agent` and
  emits no routing.
