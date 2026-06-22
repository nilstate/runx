---
name: standup-digest
description: Turn bounded work events into a trusted daily standup digest with shipped work, blockers, risks, next actions, and source mapping.
runx:
  category: ops
---

# Standup Digest

Turn bounded work events into one operator-ready standup digest that says what
it read.

## What this skill does

`standup-digest` reads a bounded set of work events such as GitHub issue or PR
updates, build events, and operator notes. It groups the useful signal into one
daily digest with:

- `shipped`: what actually landed or moved forward
- `blockers`: what is stuck and why
- `risks`: what could slip or regress next
- `next_actions`: what should happen after the digest
- `source_map`: how every digest item maps back to input event ids, timestamps,
  and links

The skill is read-only. It does not post to Slack, reply on GitHub, or mutate a
tracker. It prepares a digest that can later compose with `github-sync`,
`issue-triage`, or `slack-notify`.

Its authority stays narrow: the caller grants bounded read context through the
input `events`, and the proof surface is the emitted `source_map` plus the
sealed runx receipt. If a later lane wants to post or sync the digest, that is
a separate gated action with its own authority and receipt.

## When to use this skill

- You have a bounded daily or shift-sized event set and need a standup summary.
- You need a digest that can be audited back to concrete event ids.
- You want noisy or duplicate events collapsed before a human reviews the day.
- You want blocker and next-action sections, not just a flat activity log.

## When not to use this skill

- To fetch events from providers directly. Hydrate the bounded events first.
- To post a standup into Slack or email. Use `slack-notify` or another governed
  outbound lane after review.
- To decide how to answer one issue thread. Use `issue-triage`.
- To synchronize repo state or mutate tickets. Use `github-sync` or a mutation
  lane.
- To summarize an unbounded backlog or a whole quarter of work. Keep the event
  set bounded enough to audit.

## Procedure

1. Read the caller-supplied `events` array and reject missing or empty input.
2. Keep only evidence-bearing events that affect delivery status, blockers,
   risk, or next action.
3. Collapse duplicates and near-duplicates by shared work item, repeated build
   status, or repeated note content when they do not change the operational
   meaning.
4. Classify events into shipped work, blockers, risks, and next actions.
5. Emit each digest item with a stable `item_id`, a concise summary, and the
   supporting `event_ids`.
6. Build `source_map` entries that preserve source timestamps and links when the
   caller supplied them.
7. Stop at the digest. Do not send, sync, or mutate anything downstream.

## Edge cases and stop conditions

- Missing `events`: return `needs_agent`.
- Empty `events`: return `needs_agent`.
- Events with no ids: return `needs_agent`; the digest must stay auditable.
- Duplicate or noisy events: merge them when they do not add new meaning, and
  keep all contributing ids in `source_map`.
- Conflicting events on the same work item: surface the conflict as a blocker or
  risk instead of pretending the timeline is clean.
- Missing timestamps or links: keep the digest item, but preserve only the
  fields the caller actually supplied.
- Sensitive content in notes: the caller should redact before invocation; this
  skill should not widen distribution.

## Output schema

```yaml
shipped:
  - item_id: string
    summary: string
    event_ids: [string]
blockers:
  - item_id: string
    summary: string
    event_ids: [string]
    reason: string
risks:
  - item_id: string
    summary: string
    event_ids: [string]
next_actions:
  - item_id: string
    summary: string
    owner: string
    event_ids: [string]
source_map:
  - item_id: string
    section: shipped | blockers | risks | next_actions
    event_ids: [string]
    source_timestamps: [string]
    source_links: [string]
```

The digest is trusted only when every item maps back to one or more source
events. `source_map` is the audit trail, not optional decoration.

## Worked example

Input events include a merged PR, a green deploy, two repeated CI failures on a
feature branch, and an operator note that a dependency upgrade still needs
approval. The digest emits one shipped item for the merged PR and deploy, one
blocker item for the repeated CI failure, one risk item for the pending
dependency approval, and one next action telling the owner to rerun the branch
after fixing the failing check. The duplicate CI events are collapsed into one
blocker with both event ids preserved in `source_map`.

## Inputs

- `objective` (required): what the digest should answer for the operator.
- `events` (required): bounded work events with ids and supporting context.
- `constraints` (optional): operator rules such as owner naming, tone, or
  cutoff policy.
- `time_window` (optional): the reporting window label, such as `today` or
  `2026-06-22`.
