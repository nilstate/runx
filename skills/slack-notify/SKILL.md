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

It refuses to be a generic Slack client. It does not list channels, manage
members, read history, react, or open DMs as a side effect. It plans one
outbound notification to one named target and nothing else.

Distinctness: it plans a single channel notification with egress gates; send-as
plans broader cross-provider sends, github-sync moves repo state.

## What this skill does

`slack-notify` produces a `notify_plan`: a sealed intent to post one message to
one Slack channel, bound to the principal posting it, the content digest, the
send class, and the gates that must clear first. The plan names the provider
actions a connector lane would run, but it does not call the Slack API. Delivery
is a separate, gated step; this skill stops at the reviewable plan.

The hard line it draws: a notification to `#build-status` is routine, a post
that fires `@channel` across 4,000 people or lands in a shared external channel
is not. The first proceeds as `direct`; the second is classified `broadcast`,
flagged with `approval_required`, and held until a human signs off.

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

## Governance

- Egress scope is `net:allowlist` pinned to the configured Slack connector. No
  other host is reachable from this plan. The skill never widens egress to add a
  webhook, a second workspace, or a non-Slack endpoint.
- The connector identity binds to the principal. The plan posts as the principal
  the caller named, not as an ambient bot token chosen at send time.
- Send class drives the gate. `direct` posts to a normal internal channel clear
  preflight only. `broadcast` covers `@channel`, `@here`, `@everyone`, and any
  external or shared (Slack Connect) channel; these set
  `gates.approval_required: true` and hold for human sign-off.
- Preflight is always required: connector reachable, channel resolvable, the
  principal allowed to post there, content digest present.
- The receipt carries the channel id, the principal ref, the content digest, the
  send class, the gate decisions, and the connector identity. It does not carry
  the message body, secret values, or any membership roster. Review can prove
  what was authorized without reading what was said.

## Procedure

1. Resolve the principal and confirm a Slack connector and workspace are
   configured. No connector means `needs_agent`.
2. Resolve the target channel to a stable reference. Determine whether it is
   internal, external, or shared (Slack Connect).
3. Bind content by digest. Accept either an inline `message` (hash it, keep a
   short safe preview) or a `content_ref` plus `digest`. Never approve mutable
   prose by summary alone.
4. Classify the send. Internal channel with no broadcast mention is `direct`.
   Any `@channel`/`@here`/`@everyone`, or any external or shared channel, is
   `broadcast`.
5. Set gates. `direct` requires preflight only. `broadcast` requires preflight
   and human approval.
6. Run preflight checks; record any failure as a blocker. A consent or policy
   block (the principal may not post to this channel) is a hard blocker.
7. Emit the smallest `notify_plan` a connector lane can execute without widening
   egress, plus the ordered `provider_actions` it would run.
8. Stop. Return `needs_agent` for a missing connector or missing required
   field; return a `blocked` decision when policy or consent forbids the post.

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
- **Raw secret or PII in the message:** the preview is truncated and scrubbed;
  the digest binds the full content, but no value enters the plan or receipt. If
  scrubbing would remove the evidence needed to decide, return `needs_agent`.

## Output

- `notify_plan.decision`: `ready` (gates can be satisfied and the post may
  proceed to the connector lane), `needs_review` (a gate, usually approval, is
  outstanding), or `blocked` (policy or consent forbids the post).
- `notify_plan.channel`: object with `ref` (stable channel id), `name`, and
  `kind` (`internal` | `external` | `shared`).
- `notify_plan.content`: object with `ref`, `digest`, and a short scrubbed
  `preview`. No full body, no secret values.
- `notify_plan.principal`: ref of the actor the post is sent as.
- `notify_plan.send_class`: `direct` | `broadcast`.
- `notify_plan.gates`: object with `approval_required` and `preflight_required`
  booleans, plus `approval_ref` when an approval is recorded.
- `notify_plan.blockers`: array of named blockers with cause; empty when clear.
- `notify_plan.provider_actions`: ordered array of connector steps the lane
  would run (resolve channel, preflight, gated post), described, not executed.

Key fields for review: `decision`, `send_class`, `channel.kind`,
`gates.approval_required`, `content.digest`.

## Inputs

- `channel` (required): the destination channel, by id or name.
- `content` (required): the message. Either `{ message: "..." }` for inline text
  or `{ content_ref: "...", digest: "..." }` for digest-bound content.
- `principal` (required): who the post is sent as.
- `provider_context` (optional): connector and workspace readiness, e.g. the
  result of a connector status check.

## Quality Profile

- Purpose: produce one reviewable, digest-bound plan to post a single Slack
  notification, with the egress lane named and any broad or external post held
  for human approval.
- Audience: the operator, reviewer, or connector lane that will approve or
  execute the post, and later anyone auditing the receipt.
- Artifact contract: `notify_plan` with `decision`, `send_class`,
  `channel.kind`, `content.digest`, `gates.approval_required`, and `blockers`
  populated. Content is referenced by digest and a scrubbed preview; never by
  full body.
- Evidence bar: channel kind, send class, and gate decisions are grounded in the
  resolved channel and the provider context, not assumed. A missing connector or
  unresolvable channel is named as a blocker, not papered over.
- Voice bar: terse operator prose; the plan reads like a runbook entry. CLI and
  field text stay factual. No marketing language, no AI-authored framing.
- Strategic bar: the plan must make one decision easier, post or hold, and must
  make a `broadcast` impossible to send by accident. A `direct` status ping
  should not drag a human into the loop; a room-wide page should never skip one.
- Stop conditions: return `needs_agent` when the connector, workspace, channel,
  principal, or digest-bound content is missing; return a `blocked` decision
  when policy or consent forbids the post; return `needs_review` when approval
  is required and not yet recorded.
