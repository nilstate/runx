---
name: github-sync
description: Plan or execute a scoped GitHub issue, thread, or pull-request synchronization through a configured Runx Connect grant, with approval and readback on writes.
runx:
  category: ops
---

# GitHub Sync

Define one bounded synchronization between local Runx state and a GitHub
repository. The skill makes direction, resource set, filters, content identity,
scope, cursor, and approval posture explicit before the hosted GitHub driver is
allowed to read or mutate GitHub.

The default runner is deterministic planning. The `pull` and `push` runners
execute that same plan through Runx's native provider boundary. Pulls need no
human approval because they are bounded reads. Each push carries exactly one
bounded typed mutation, stops at an approval bound to its native digest, uses a
stable idempotency key, and closes only on an independent GitHub readback. No
GitHub token enters this package.

## Composes

<!-- Generated from the native execution closure; run pnpm core-skills:composes:generate. -->

- `data-store#append_event`
- `data-store#read_projection`

## When to use it

Use `github-sync` when an operator needs a reproducible pull or push contract for
issues, pull requests, or threads—especially when cursor state must survive
across runs. Use `pull` when the configured Connect grant may read repository
state. Use `push` for one already-decided issue, pull-request, or thread
mutation; use another run for another mutation. This avoids presenting a
non-atomic remote batch as one transaction. Use `issue-triage` to decide what an
issue means and `issue-to-pr` to govern an implementation lane.

Do not use a plan as evidence that remote state was read or changed. Only the
native `runx.provider.operation.v1` result from `pull` or `push` is provider
evidence. Do not silently turn a denied push into a pull.

## How it works

1. Validate the exact `owner/name` repository, direction, resource kind, bounded
   filters, maximum result count, and requested scope.
2. A `pull` plan requires read scope and records the exact resources a provider
   may fetch.
3. A `push` plan requires write scope and exactly one typed mutation. It
   rejects unknown fields and oversized content, then returns
   `ready_for_approval`; planning itself does not open or satisfy that gate.
4. Optional `plan_and_append_cursor` composes the canonical `data-store` skill
   to append the bounded plan and read the projection back. That proves local
   cursor persistence, not GitHub synchronization; this package does not own a
   second cursor database or storage adapter.
5. `pull` executes the plan with `repo.read`. `push` hashes the exact mutation
   with the native digest tool, requests approval, executes it with
   `repo.write`, verifies the returned digest, and reads the resource back.
   Both runners use the native provider lane.

## Inputs and result

- `repo` is exactly `owner/name`.
- `direction` is `pull` or `push`.
- `resources` contains the issue, PR, or thread selector and a limit no greater
  than 100. A push has one `mutations` entry with `ref`, `op`, and an exact
  typed `payload`. Issue and PR changes use `op: update`; new thread comments
  use `op: comment`. Bodies are capped at 65,536 characters.
- `scope` is the requested read or write scope.

The `runx.github_sync.v1` plan records exact direction, provider operation,
scope, filters, blockers, approval posture, cursor state when used, and the
explicit absence of remote effects. Execution additionally emits the native
provider-operation packet; it does not rewrite the planning packet to imply a
remote effect.

## Stop conditions

- Refuse malformed repositories, unknown resource kinds, unbounded selectors,
  limits above the contract, multiple mutations, unknown mutation fields, or
  content beyond the declared bounds.
- Refuse push when write scope is missing; do not degrade silently.
- Do not treat local cursor persistence as remote provider readback.
- Refuse a missing, ambiguous, wrong-provider, or under-scoped GitHub Connect
  grant rather than falling back to a raw token or package HTTP client.
- Do not claim comments, labels, issues, or PRs were read or changed until the
  native provider operation proves the expected access, operation, and readback.

## Example

A caller wants to pull the next 50 open issues after cursor `2`. Planning can
persist that cursor locally; `pull` then performs `issues.read` through the
configured grant and returns the provider result. To close issue 241, a push
carries `ref: issues/241`, `op: update`, and
`payload: {state: closed, state_reason: completed}`. Runx hashes and approves
that exact mutation, applies only that issue update, and reads issue 241 back.
