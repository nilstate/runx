---
name: ci-failure-triage
description: Classify CI failures from supplied logs and emit a read-only routing packet for downstream issue-intake.
runx:
  category: code
---

# CI Failure Triage

Classify one CI failure from the supplied logs, commit context, repository
state, and escalation policy. The skill emits a typed triage packet for a
separate governed issue-intake, issue-to-pr, or pr-review-note run. It does not
rerun CI, open tracking items, page operators, mutate repositories, or claim
that any downstream lane has acted on its recommendation.

## What This Skill Does

`ci-failure-triage` makes the first incident-response decision for a failed CI
run. It reads the failure evidence and returns one of four verdicts:

- `flake`: a transient or nondeterministic signal, such as a timeout, network
  interruption, scheduler cancellation, or known intermittent test symptom.
- `infra`: a runner, service, cache, quota, secret, or dependency-hosting issue
  unrelated to the submitted code.
- `real-break`: a code, test, type, lint, build, or contract failure that is
  visible in the supplied logs or commit context.
- `dep`: a dependency, lockfile, toolchain, version, registry, or external
  package break with direct evidence in the supplied inputs.

The output is always read-only. For `flake` it may include a rerun verdict. For
`infra` it may include an operator page note. For `real-break` or `dep` it may
include a routing decision recommending `issue-to-pr`. Under-threshold,
truncated, conflicting, or unsupported evidence must stop with `needs_agent`
instead of emitting a lane recommendation.

## When To Use

- A pull request, branch, or scheduled build failed and a downstream system
  needs a grounded first classification.
- The operator has enough log, commit, and repository-state evidence to decide
  whether the next governed step should be retry, infra observation, or issue
  intake.
- The caller needs a stable `runx.ci.triage.v1` packet for later review.

## When Not To Use

- To rerun CI, change build settings, open issues, post comments, page humans,
  merge code, or otherwise perform an effect.
- To classify from a screenshot, short status badge, or missing/truncated log
  that cannot support the requested confidence threshold.
- To infer a root cause from project history, maintainer intent, or unstated
  repository facts not supplied in the inputs.

## Inputs

- `ci_failure`: object containing:
  - `logs`: raw or summarized CI log evidence.
  - `commit`: commit SHA, title, changed files, or relevant diff summary.
  - `repo_state`: branch, workflow name, matrix job, retry history, or current
    repository state.
- `repo_config`: CI provider, important commands, protected-branch policy,
  known flaky jobs, owned paths, or routing lanes.
- `escalation_policy`: object containing `min_confidence` and any lane
  constraints.

## Output

Emit `triage_packet` using schema `runx.ci.triage.v1`:

```yaml
triage_packet:
  schema: runx.ci.triage.v1
  classification:
    verdict: flake | infra | real-break | dep
    confidence: number
    evidence_refs: array
  read_only_rerun_verdict:
    allowed: boolean
    rationale: string
  read_only_page_note:
    target: string
    rationale: string
  routing_decision:
    recommended_lane: issue-intake | issue-to-pr | pr-review-note | hold
    rationale: string
  handoff:
    seam: dispatch-by-naming
    downstream_candidates: array
  refusals: array
```

Exactly one of `read_only_rerun_verdict`, `read_only_page_note`, or
`routing_decision` should be populated. The packet must include cited evidence
refs for each material claim. Do not include a mint request, attenuation
request, or any effect authorization.

## Procedure

1. Parse the failure logs first. Treat logs as the highest-signal source and
   cite stable snippets, step names, file paths, or exit codes.
2. Compare log evidence with commit and repo state. Do not attribute a root
   cause to changed files unless the supplied evidence links them.
3. Apply the classification taxonomy:
   - flake: transient job/runner/network symptoms with no deterministic code
     failure.
   - infra: external service, runner, cache, secret, quota, or environment
     break outside the change surface.
   - real-break: deterministic compile, type, test, lint, build, or contract
     failure visible in the supplied evidence.
   - dep: dependency or toolchain resolution/version failure visible in the
     supplied evidence.
4. Estimate confidence from directness, specificity, repeatability, and
   completeness of the evidence.
5. If confidence is below `escalation_policy.min_confidence`, or if logs are
   truncated before the failing command, stop with `needs_agent` and name the
   missing evidence.
6. Emit the read-only packet for a downstream governed run. The venue or driver
   dispatches that later run by name; this skill never starts it.

## Stop Conditions

Return `needs_agent` when:

- logs are truncated, missing, contradictory, or too generic;
- the proposed verdict would require repository facts not supplied in the
  inputs;
- confidence is below `escalation_policy.min_confidence`;
- the caller asks the skill to rerun CI, open an issue or PR, page an operator,
  mutate a repository, or claim a lane effect;
- more than one action family would need to be populated.

## Harness Coverage

The harness declares exactly two cases:

- `real_break_clear_logs`: a clear TypeScript compile error seals as
  `real-break` with a routing decision recommending `issue-to-pr`.
- `ambiguous_truncated_logs`: a truncated log cannot support the minimum
  confidence and stops with `needs_agent`.
