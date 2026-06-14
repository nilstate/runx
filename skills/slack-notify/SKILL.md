---
name: slack-notify
description: Plan a governed Slack notification under scoped egress, gating broad or external posts behind human approval before anything leaves the workspace.
runx:
  category: ops
---

# Slack Notify

Decide whether a single Slack post is safe to send, who it reaches, and where it
must stop for a human. The skill turns "tell #deploys the build is green" into a
reviewable plan: one channel, one digest-bound message, one egress lane, and an
explicit gate when the post would page a room or cross a workspace boundary.

## What this skill does

`slack-notify` produces a `notify_plan`: a sealed intent to post one message to
one Slack channel, bound to the principal posting it, the content digest, the
send class, and the gates that must clear first. The plan names the provider
actions a connector lane would run, but it does not call the Slack API. Delivery
is a separate, gated step; this skill stops at the reviewable plan.

The hard line it draws: a notification to `#build-status` is routine, a post
that fires `@channel` across 4,000 people or lands in a shared external channel
is not. The first proceeds as `direct`. The second is classified `broadcast`,
flagged with `approval_required`, and held until a human signs off.

Distinctness: this is not a generic Slack client. It plans one outbound
notification to one named target and nothing else, and never lists channels,
manages members, reads history, reacts, or opens DMs as a side effect.
`send-as` plans broader cross-provider sends; `github-sync` moves repo state.

## When to use this skill

- An agent needs to post a status, alert, or summary to one Slack channel on a
  principal's behalf.
- A workflow wants the post reviewed before it pages a room with `@channel` or
  `@here`.
- The destination might be an external or shared channel and the boundary needs
  to be made explicit.
- A reviewer needs to tell apart a routine status ping from a broadcast.

## When not to use this skill

- To send across providers or run a campaign. Use `send-as` for the broader
  authority model.
- To move repository state or open issues. That is `github-sync`'s job, not a
  notification.
- To browse channels, read history, manage membership, or run slash commands.
- To post raw secrets, tokens, customer records, or fetched page bodies into a
  channel. Content is referenced by digest; values do not enter the plan or the
  receipt.
- To post without a named principal and a named channel.

## Procedure

1. Resolve the principal and confirm a Slack connector and workspace are
   configured. No connector means `needs_agent`. The connector identity binds to
   the principal the caller named, not an ambient bot token chosen at send time.
2. Resolve the target channel to a stable reference. Determine whether it is
   internal, external, or shared (Slack Connect).
3. Bind content by digest. Accept either an inline `message` (hash it, record
   only its length and detected broadcast mentions) or a `content_ref` plus
   `digest`. The message body never enters the plan. Never approve mutable prose
   by summary alone.
4. Classify the send. Internal channel with no broadcast mention is `direct`.
   Any `@channel`/`@here`/`@everyone`, or any external or shared channel, is
   `broadcast`.
5. Set gates. The send class drives the gate. `direct` requires preflight only.
   `broadcast` requires preflight and human approval; it is held for sign-off.
6. Run preflight checks: connector reachable, channel resolvable, the principal
   allowed to post there, content digest present. Record any failure as a
   blocker. A consent or policy block (the principal may not post to this
   channel) is a hard blocker.
7. Emit the smallest `notify_plan` a connector lane can execute without widening
   egress, plus the ordered `provider_actions` it would run. Egress scope stays
   `net:allowlist` pinned to the configured Slack connector; the plan never adds
   a webhook, a second workspace, or a non-Slack endpoint.
8. Stop. Return `needs_agent` for a missing connector or missing required field;
   return a `blocked` decision when policy or consent forbids the post.

## Edge cases and stop conditions

- **No connector or workspace:** return `needs_agent`. There is no egress lane
  to plan against.
- **No channel or no principal:** return `needs_agent`; required and not
  inferred.
- **Unresolvable channel:** preflight blocker; the plan cannot bind a target.
- **`@channel`, `@here`, `@everyone`:** classify `broadcast`, require approval.
- **External or shared channel:** classify `broadcast`, require approval, and
  record that the destination crosses a workspace boundary.
- **Mutable or unhashed content:** return `needs_agent` until content is
  digest-bound.
- **Policy or consent forbids the post:** `decision: blocked`; record the
  blocker and do not plan delivery.
- **Raw secret or PII in the message:** the digest binds the full content, but
  no body text, secret, or value enters the plan or receipt. Only the content
  length and detected broadcast mentions are recorded. If that is not enough to
  decide whether the post is safe, return `needs_agent`.

## Output schema

The receipt carries the channel id, the principal ref, the content digest, the
send class, the gate decisions, and the connector identity. It does not carry
the message body, secret values, or any membership roster. Review can prove what
authority was granted without reading what was said.

```yaml
notify_plan:
  decision: ready | needs_review | blocked
  principal: string
  channel:
    ref: string
    name: string
    kind: internal | external | shared
  content:
    ref: string
    digest: string
    length_chars: integer
    mentions: array
  send_class: direct | broadcast
  gates:
    preflight_required: boolean
    approval_required: boolean
    approval_ref: string
  blockers: array
  provider_actions: array
```

Key fields for review: `decision`, `send_class`, `channel.kind`,
`gates.approval_required`, `content.digest`. A `ready` decision means the gates
can be satisfied and the post may proceed to the connector lane. `needs_review`
means a gate, usually approval, is outstanding. `blocked` means policy or
consent forbids the post. `provider_actions` is an ordered array of connector
steps the lane would run (resolve channel, preflight, gated post), described,
not executed.

## Worked example

Input: "Post the DB failover update to #incidents with an `@here`," carrying a
digest-bound draft, a `svc:release-bot` principal, and a ready Slack connector
that allows the principal to post.

Output: `decision: needs_review`; `send_class: broadcast` because the message
contains an `@here`; `gates.approval_required: true`; the channel binds to its
stable id; content is digest-bound with only its length and the detected
`@here` mention recorded. The provider actions are resolve-channel, preflight,
then a post gated on human approval. No message leaves the workspace until the
approval gate clears.

## Inputs

- `channel` (required): the destination channel, by id or name.
- `content` (required): the message. Either `{ message: "..." }` for inline text
  or `{ content_ref: "...", digest: "..." }` for digest-bound content. Raw
  secrets and PII must not appear.
- `principal` (required): who the post is sent as.
- `provider_context` (optional): connector and workspace readiness, e.g. the
  result of a connector status check.
