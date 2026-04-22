---
name: evolve
description: Governed repo evolution with fixed phase semantics and bounded outcomes.
---

# Evolve

Evolve the current repository through governed phases with fixed semantics and
optional bounded revision. With no objective, the default behavior is
introspective: analyze the repo, recommend one bounded improvement, and stop
at a plan-quality artifact set.

This is not autonomous code generation. It governs the shape around
cognition — every phase produces a typed artifact, every mutation requires
approval, every step emits a receipt. A single evolve run ends in a bounded
artifact, not an open-ended improvement loop.

## Canonical semantics

Complex runx skills share one internal phase language:

- `scope`
- `ingest`
- `model`
- `materialize`
- `evaluate`
- `revise`
- `verify`
- `ratify`

The current `evolve` runner uses a bounded subset and compresses some phases
into fewer concrete steps. That is allowed. What stays fixed is the meaning of
the phases, not the number of steps. When a runner opts in, runx may also
append a runner-owned post-run reflect projection after the receipt is written.
That projection is journal-only metadata, not another canonical phase.

## Current runner mapping

### Introspect

Caller-mediated (agent-step). This is the zero-argument recommendation lane.
It uses `scope + ingest + model` to analyze the current repo and produce:

- `opportunity_report` — ranked opportunities grounded in repo evidence
- `recommended_objective` — one bounded next move
- `change_plan` — a concrete plan for that recommendation
- `spec_document` — a draft scafld-style spec when governance applies

No approval gate and no mutation happen in this runner. It is introspection
only.
It also opts out of post-run reflect because it is already an introspective
lane.

### Preflight

Deterministic. This is the current `scope + ingest` step. It inspects the
target repo and produces a `repo_profile`:
repo root, git state, base branch, dirty worktree, `.ai/` presence
(scafld initialized), detected languages, test commands, risk signals.
No agent cognition, no mutation.

### Plan

Caller-mediated (agent-step). This is the current `model` step and also drafts
bounded plan artifacts. Given the objective and repo profile, it produces four
artifacts in one pass:

- `objective_brief` — restatement with target kind, constraints,
  success criteria.
- `diagnosis_report` — current repo state relative to the objective.
- `change_plan` — ordered phases, acceptance checks, touchpoints, risk.
- `spec_document` — draft scafld spec when governance applies.

Directed `evolve` runs opt into runner-owned post-run reflect. That projection
is derived from the completed receipt and run journal after the bounded plan
lane finishes; it does not add another visible chain step or mutation path.

### Termination guard

`evolve` currently stops at plan/spec artifacts. If a caller requests
`terminate=patch` or `terminate=pr`, the runner fails immediately with a clear
error instead of pretending it can mutate or publish.

## Revision policy

`evolve` does not currently perform revision rounds. That is intentional. When
bounded revision is introduced, it must be explicit and policy-controlled, for
example `max_rounds: 1` or `2`, with defined stop and escalation conditions.

## Invocation modes

- `runx evolve` — introspect the current repo and recommend one bounded
  improvement
- `runx evolve "<objective>"` — plan a directed change
- `runx evolve "<objective>" --terminate patch|pr` — currently rejected until
  a real execution lane exists

## Evolution targets

The objective string determines the target. The preflight phase resolves
the concrete target from the current repo context.

- **Repo**: "add websocket adapter support" — improve the codebase
  toward an objective.
- **Skill**: `--skill ./skills/sourcey` — improve a specific skill package.
- **Receipt**: `--receipt rx_8f3a` — repair based on a failed run.
- **Self**: run against the runx repo itself in the proving ground.

## Termination

- `spec` (default): stop after planning. No mutation.
- `patch`: not yet supported in this shipped runner.
- `pr`: not yet supported in this shipped runner.

## Boundary rules

- A single evolve run ends in a bounded artifact, not another hidden loop.
- Policy evaluates structured fields, never prose.
- If later execution is added, it must route through real tools, scafld, or
  other governed lanes instead of synthetic internal steps.

## Inputs

- `objective` (optional): what to evolve toward. If omitted, `evolve` uses the
  introspective recommendation runner.
- `repo_root` (optional): repository root. Defaults to cwd.
- `terminate` (optional): defaults to `spec`. Other values are currently
  rejected by the shipped runner.
