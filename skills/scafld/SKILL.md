---
name: scafld
description: Run a governed scafld v2 spec-driven lifecycle (plan, build, review, finalize) with finalize gated behind a passing review.
runx:
  category: code
---

# scafld

Run one scafld v2 task through its lifecycle under runx authority, and refuse to
seal work that has not passed review.

The decision this skill makes easier: "is this change actually done, or does it
just look done?" scafld already drives plan, build, and review. What it cannot do
alone is bind the finalize seal to a passing review verdict inside a governed run
that leaves a receipt. This skill is that binding. It advances the lifecycle one
honest step at a time, and it treats finalize as a gate, not a formality.

It refuses to finalize a task whose review verdict is not a pass. A failing or
absent review returns `needs_review` with the blocking findings carried forward,
never a `sealed` outcome with the findings quietly dropped.

## Distinctness

It is the standalone governed scafld lifecycle. `issue-to-pr` uses scafld only as
one inner stage of its issue-to-PR graph, with thread parsing, fix authoring, and
provider push around it; this skill runs the bare lifecycle for a task that
already exists in a repo, and stops at the seal. `evolve` plans and stops at a
spec without ever building or reviewing. `finalize` runs only the seal step in
isolation; this skill owns the whole arc and the gate in front of the seal.

## What this skill does

Given an objective or an existing spec reference plus a repo, it runs the
requested lifecycle stage:

- `plan`: turn the objective into a scafld spec, or validate the referenced spec,
  and stop at a plan-quality artifact.
- `build`: advance the approved spec through scafld build until the task is
  review-ready.
- `review`: run scafld's adversarial review and surface the verdict with its
  blocking findings.
- `finalize`: seal the task only when the review verdict is a pass, and return
  the receipt reference for the seal.

Each stage produces a typed artifact referenced by digest or repo-relative path,
not by inlined file bodies. The default stage is `plan`, which never mutates beyond
the spec surface and never seals.

## When to use this skill

- A scafld task exists in a repo and you want to advance it one governed stage.
- You want finalize to be impossible until review passes, with the refusal on the
  record.
- You want a receipt that proves which verdict authorized the seal.
- A larger graph wants the lifecycle as a reusable unit instead of re-wiring
  plan, build, review, and finalize by hand.

## When not to use this skill

- To parse an issue thread and open a pull request. Use `issue-to-pr`.
- To plan a change and stop at a spec with no build or review. Use `evolve`.
- To seal a task in isolation without running the lifecycle around it. Use
  `finalize`.
- To force a seal past a failing or missing review. This skill refuses.
- To dump raw spec bodies, full review transcripts, or local secrets into the
  artifact. References, digests, and verdicts only.

## Governance

- Scopes: `repo:write` and `proc:exec`, both gated. `repo:write` covers spec and
  scafld control-plane writes under the task's `.scafld` tree. `proc:exec` covers
  invoking the scafld binary for build and review.
- Review gate: finalize is only reachable when the review verdict is a pass. A
  non-pass verdict short-circuits to `needs_review` before any seal write, so the
  seal scope is never exercised on unreviewed work.
- Preflight: `finalize` requires a recorded review verdict from this run or a
  referenced prior review receipt. No verdict means `needs_review`, not a guess.
- The seal write is the only finalize mutation; it is gated and never runs unless
  the review verdict gate is already satisfied.
- Receipt contents: the receipt records the lifecycle phase, the spec reference,
  artifact references by path or digest, the review verdict with its blocking
  findings, the authorizing review receipt reference, and the seal receipt
  reference when sealed. It carries the quality profile and voice profile hashes.
  It never carries raw file bodies, full review transcripts, or secret values.

## Output

Return a single `scafld_run` object, wrapped as `scafld_run_packet` under the
`runx.scafld.v1` packet. Describe the run; never inline file bodies, full review
transcripts, or any secret material.

- `scafld_run.phase`: the lifecycle stage that ran, one of `plan`, `build`,
  `review`, `finalize`.
- `scafld_run.spec_ref`: the scafld spec the run operated on, by repo-relative
  path or content digest.
- `scafld_run.artifacts`: artifacts produced this stage, keyed by phase, each
  referenced by `path` or `digest` plus a short `kind`. No file bodies.
- `scafld_run.review`: `{ verdict, blocking_findings: [] }`. `verdict` is one of
  `pass`, `fail`, `none`. `blocking_findings` carries finding summaries and refs,
  never raw flagged file contents.
- `scafld_run.finalize`: `{ sealed: boolean, receipt_ref }`. `sealed` is true only
  on a passing review; `receipt_ref` points at the seal receipt when sealed.
- `scafld_run.next_lane`: the next bounded stage or stop state, for example
  `build`, `review`, `finalize`, `needs_review`, or `done`.

## Quality Profile

- Purpose: advance one scafld v2 task through its governed lifecycle and bind the
  finalize seal to a passing review verdict.
- Audience: the maintainer or follow-on skill that owns the task and needs to know
  what stage ran, what the review found, and whether the work is sealed.
- Artifact contract: `scafld_run` object wrapped as `scafld_run_packet`
  (`runx.scafld.v1`). Key fields: `phase`, `spec_ref`, `artifacts` (per phase, by
  path or digest), `review` (`verdict` plus `blocking_findings`), `finalize`
  (`sealed`, `receipt_ref`), and `next_lane`.
- Evidence bar: `phase`, `spec_ref`, and every artifact reference must trace to
  the actual scafld task state and binary output, not to assumed structure. The
  review verdict must be the verdict scafld returned, with its blocking findings
  preserved; `sealed: true` must trace to a real seal receipt reference.
- Voice bar: terse maintainer-to-maintainer status. Report the stage, the verdict,
  and the next lane plainly. Do not narrate the scafld binary's internals or pad
  with generic CI language. CLI and status text stays factual.
- Strategic bar: the run must make the next decision obvious: build it, review it,
  fix the blocking findings, or trust the seal. A run that cannot make that
  decision clearer should stop instead of emitting a vague pass.
- Stop conditions: return `needs_review` when the review gate is not a pass and a
  finalize was requested, carrying the blocking findings; return `needs_agent`
  when `objective`/`spec_ref` or `repo` is missing, or when the spec cannot be
  resolved without inventing scope.

## Inputs

- `objective` (required unless `spec_ref` is set): the bounded change the task
  should accomplish, used to author or anchor the spec.
- `spec_ref` (optional): repo-relative path or digest of an existing scafld spec
  to operate on instead of authoring from `objective`.
- `repo` (required): repository slug or root the task lives in.
- `lifecycle` (optional): which stage to run, one of `plan`, `build`, `review`,
  `finalize`. Defaults to `plan`.
