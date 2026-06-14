---
name: github-sync
description: Plan a scoped pull or push of GitHub issues, threads, or PRs, gating any write behind human approval.
runx:
  category: ops
---

# GitHub Sync

Decide exactly what state to move between a GitHub repo and the local graph, in
which direction, and whether the agent is even allowed to write.

`github-sync` is the generic repo state connector. It turns a loose request like
"sync the open issues" into a bounded plan that names the resources, the
direction, the scope, the records it will touch, and the point where the run
must stop for a human. A pull is observation and stays inside `repo:read`. A
push is mutation and never proceeds without an explicit `repo:write` grant and
human approval.

## What this skill does

`github-sync` produces a sealed `sync_plan`: a scoped record of which GitHub
resources the run will pull or push, the scope it will use, the gates a write
must clear, and any blockers that stop the run cleanly. For a push it carries a
`diff_summary` described by digest and ref, never by raw body text, so a
reviewer can approve the shape of a change without leaking issue contents,
tokens, or PII into the plan or the receipt.

The plan binds direction to scope. `pull` is read-only and lists the resources
it will fetch. `push` enumerates the mutations by ref and digest, marks
`approval_required: true`, and refuses to proceed past planning when the run
lacks a `repo:write` grant.

This skill plans the sync; it does not perform the GitHub mutation itself. The
plan is the artifact a downstream adapter executes after the approval gate
clears. Planning and mutation stay on opposite sides of the gate so a review can
read intent before anything changes on the remote.

## When to use this skill

- An agent needs to fetch a bounded set of issues, threads, or PRs into the
  local graph for triage or analysis.
- An agent needs to mirror local state back to GitHub (reopen, label, comment,
  close) and the operator wants the write shape reviewed before it lands.
- A workflow must prove which repo, direction, and scope a sync used, with a
  receipt that names the resources touched.
- A review needs to distinguish a read-only pull from a write that crossed an
  approval gate.

## When not to use this skill

`github-sync` is the generic repo state connector. Reach for it when the job is
moving issue, thread, or PR state in or out, not authoring a change or composing
one comment.

- To drive a thread through spec, build, review, and a draft PR. Use
  `issue-to-pr`, which governs the full issue-to-PR lane.
- To draft one review comment on one PR. Use `pr-review-note`.
- To push without a named repo and direction.
- To carry raw issue bodies, comment text, access tokens, or contributor PII in
  the plan or receipt. Reference them by digest, span, or ref only.
- To bypass the human approval gate on any write.

## Procedure

1. Resolve the target repo and confirm the run holds at least `repo:read`.
2. Read `direction`. `pull` is observation; `push` is mutation and changes the
   gate posture.
3. Read `resources`. Bind the concrete set: issues, PRs, or threads, plus the
   filters that bound it (state, label, author, range). An unbounded "all"
   becomes a blocker until reconfirmed.
4. Read `scope`. A `push` requires `scope: write` backed by a real `repo:write`
   grant. If a write is requested without that grant, stop and refuse rather
   than downgrade to a silent pull.
5. For a `pull`, list `resources_touched` by ref and leave `diff_summary` empty.
6. For a `push`, build `diff_summary` as a list of intended mutations described
   by ref and content digest, set `gates.approval_required: true`, and record
   the approval reference once granted.
7. Record `scope_used` as the narrowest scope the plan actually needs.
8. Emit the smallest `sync_plan` an adapter can execute without widening
   authority, and stop at the approval gate for any write.

## Edge cases and stop conditions

- **Missing repo or direction:** return `needs_agent`; the sync target is
  undefined.
- **Write requested without `repo:write`:** the request is `refused`; never
  downgrade it to a silent pull. The plan stays unexecutable.
- **Unbounded resource set:** mark a blocker and require an explicit filter
  before a push.
- **Approval absent or denied on a push:** keep the decision blocked and the
  plan unexecutable; do not emit an executable mutation plan.
- **Raw bodies, tokens, or PII in the resource payload:** reference by digest
  and ref; if redaction would remove the evidence needed to plan, return
  `needs_agent`.

## Output schema

```yaml
sync_plan:
  decision: ready | blocked | refused | needs_agent
  repo: string                       # resolved owner/name target
  direction: pull | push
  resources_touched:                 # resources by ref; no raw bodies
    - kind: issue | pr | thread
      ref: string
      selected_by: string            # the filter that selected it
  diff_summary:                      # push only; empty for a pull
    - ref: string
      op: string
      digest: string
  scope_used: string                 # narrowest scope, e.g. repo:read or repo:write
  gates:
    approval_required: boolean       # true for any push
    approval_ref: string             # set once the write is approved
  blockers: array                    # conditions that must clear before execution
```

`sync_plan` is a composable object. Downstream skills read it as arbitrary JSON;
the fields above are the contract a reviewer and adapter rely on.

The receipt (`runx.receipt.v1`) carries the repo, direction, `scope_used`, the
resource refs touched, and the approval reference for a write. It carries no
issue bodies, comment text, tokens, or contributor PII; mutations appear as refs
and digests only. Default scope is `repo:read` and a `pull` never escalates; a
`push` needs an explicit `repo:write` grant plus human approval, so missing the
grant is a refusal and missing the approval keeps the plan blocked.

## Worked example

Input: "Sync the open triage issues into the graph" on `runxhq/runx`, with
`direction: pull`, `scope: read`, and a filter of `state:open label:triage`.

Output: `decision: ready`; `direction: pull`; `scope_used: repo:read`;
`resources_touched` lists the two matched issues by ref and the filter that
selected each; `diff_summary` is empty and `gates.approval_required` is false.
No write grant is exercised and no approval gate is opened, because a pull is
pure observation. Had the same request asked to `push` labels without a
`repo:write` grant, the run would refuse instead of reading.

## Inputs

- `repo` (required): target repository as `owner/name`.
- `direction` (required): `pull` or `push`.
- `resources` (required): structured selector for `issues`, `prs`, or `threads`
  plus filters (state, label, author, range).
- `scope` (required): `read` or `write`. A `push` needs `write` backed by a real
  `repo:write` grant.
