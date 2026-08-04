---
name: issue-triage
description: Read, analyze, and draft high-signal GitHub issue responses from bounded provider evidence without silently mutating the repository.
runx:
  category: ops
---

# Issue Triage

Turn a noisy issue queue into one evidence-backed next action. The skill helps a
maintainer decide which thread deserves attention and how to respond without
silently mutating a repository or inventing state that is not present in the
thread snapshot.

Discovery and response are separate jobs. The default `provider-respond` runner
reads one issue through a configured GitHub Connect grant, binds the returned
snapshot and readback into the receipt, and turns it into a concise profile,
recommended posture, draft reply, and follow-up plan. `discover` and `respond`
remain explicit supplied-evidence lanes for offline queues and replay. Every
lane stops at a draft; posting belongs to an approval-gated GitHub provider
operation.

## Composes

<!-- Generated from the native execution closure; run pnpm core-skills:composes:generate. -->

- `github-mcp-read-issue#default`

## When to use it

Use the default runner when the operator has a repository and issue number and
wants current provider-grounded evidence. Use `discover` for a supplied issue
queue and `respond` when an exact snapshot is already available or a receipt is
being replayed. Use `issue-intake` when the material must first become an
engineering change request, and `issue-to-pr` only after explicit promotion to
implementation.

Do not use this skill to close, label, assign, comment on, or promise work in a
repository. It prepares the maintainer decision and draft only.

## Evidence and provider boundary

Every candidate and response is bound through Runx's native data digest to the
exact issue snapshot or bounded snapshot set. `provider-respond` obtains that
snapshot through native `provider.read` with `repo.read`, and the provider
operation remains in the sealed run alongside the draft. The `mcp-read` runner composes the
bundled `examples/github-mcp-hero/read-issue` provider pattern for deterministic
tests; it is not evidence that live GitHub was queried. Supplied snapshots are
labelled as such rather than promoted to provider readback.

Ground the assessment in the thread, repository facts, receipts, and supplied
maintainer context. Do not infer contributor intent, reproduce hostile language
unnecessarily, or claim a fix, release, or investigation exists unless the
snapshot proves it.

## Inputs and result

`discover` accepts a bounded `issue_snapshots` set, a selection `query`, and
optional maintainer constraints. It returns a ranked triage queue whose ids and
rationales bind to the admitted snapshot index.

`provider-respond` accepts `owner/name`, an issue number, and optional objective
and maintainer context. `respond` accepts the same analysis context with one
already obtained `issue_snapshot`. Both return the issue profile, response
strategy, unsent response draft, and concrete follow-up actions with
`delivery_status: not_sent`; the provider status distinguishes live readback
from supplied evidence.

## Stop conditions

- Return `needs_more_evidence` or `needs_human` when a thread is ambiguous,
  hostile, unsafe, underspecified, or outside declared maintainer posture.
- Reject issue ids, repository state, labels, commitments, or completed work not
  present in the admitted snapshot.
- Do not turn maintainer context into provider evidence.
- Refuse a missing, ambiguous, wrong-provider, or under-scoped GitHub Connect
  grant instead of falling back to a raw token or package HTTP client.
- Keep mutation outside this skill. An accepted draft must move to a scoped
  GitHub comment operation with approval and provider readback.

## Example

A queue contains a reproducible regression, a broad feature request, and a stale
question. Discovery can prioritize the regression and explain why. Response can
draft a concise request for the missing version detail or describe a verified
workaround. It cannot say “fixed in the next release” unless the snapshot or
other admitted evidence establishes that fact, and it cannot post the reply.

## Agent task contracts

### `issue-triage-discover`

Rank only issues in the supplied index. Return bounded candidates and the
selection rationale an operator needs to review the ranking. Never invent issue
ids, provider state, promises, or completed work.

### `issue-triage-respond`

Draft one helpful maintainer response grounded only in the admitted issue
evidence. Preserve repository, issue number, title, and state exactly. Do not
claim work is complete unless the snapshot proves it. The draft is not sent.
