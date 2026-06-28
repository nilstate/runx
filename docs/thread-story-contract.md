# Thread Story Contract

The thread story is the reviewer-facing projection for source-thread driven
work. It is derived from receipts, scafld state, outbox entries, and provider
observations; it is not the source of truth.

## Current Shape

The shared implementation for bundled tools is inlined in the tool-local story
helpers (`tools/outbox/story.ts`, `tools/thread/story.ts`, and
`tools/thread/handoff.ts`) as typed helpers:

- `StoryMilestoneId`
- `ThreadStorySectionId`
- `FeedStoryMilestoneKind`
- `renderThreadStoryMarkdown`
- `renderFeedStoryMarkdown`
- `buildFeedStoryOutboxEntry`
- `buildStoryOutboxIdempotencyMetadata`

Source-command normalization lives one layer earlier at the adapter edge. It
supplies canonical source/thread locators, safe command summaries, target repo
hints, and dedupe keys that story builders may reference. It does not own the
durable reviewer projection, and it must not publish to Slack, GitHub, or
Sentry directly.

The thread outbox tools use those helpers to produce:

- `story.schema`: `runx.thread-story.control.v1`
- `story.data.thread_locator`
- `story.data.title`
- `story.data.next_action`
- `story.data.milestones`
- `outbox_entry.metadata.schema_version`: `runx.outbox-entry.feed-entry.v1`
- `outbox_entry.metadata.workflow`
- `outbox_entry.metadata.milestone_kind`
- `outbox_entry.metadata.idempotency.key`
- `outbox_entry.metadata.idempotency.content_hash`
- `outbox_entry.metadata.body_markdown`

Provider publication is not owned by these helpers. Local file-thread outbox
pushes are credential-free persistence for fixtures and local dogfood. GitHub,
Slack, support-channel, or other provider mutations require the separate
`thread-outbox-provider-protocol-v1` lane and Rust-supervised credential
delivery; they must not be implemented as hidden provider side effects in a
TypeScript helper package.

A source (such as Frantic) uses that provider lane for source-thread continuity
through a generic, declarative reconcile. The source publishes a
`thread_desired_state` document: per thread, the state it should be in now
(`title`, `body`, full `labels` + the `managed_labels` the source controls,
`state` open/closed, and an append-only `comments` log). The contract is
domain-agnostic: `identity_key` and `ref` are opaque to the engine, and the only
source-specific value is `source`, supplied as config. runx translates each
desired thread into provider push frames with
`tools/thread/thread_desired_state.mjs` and applies them through the GitHub
provider adapter: locate-or-create the issue by marker, reconcile labels and
open/closed to the desired state, and append any comment not already present
(deduped by outbox marker). The source remains the completion authority: open vs
closed is the source's decision expressed as desired state, and GitHub state
never completes or reopens anything on the source.

The operational driver is `scripts/thread-reconcile-sync.mjs`
(`pnpm thread:reconcile-sync` in `oss/`). It pulls the source's desired-thread
state, reconciles each thread's provider representation to match, and posts
observations back so the source can re-link the resulting threads. It is
stateless and idempotent: every run compares desired vs live and applies only
the difference, so there is no cursor and drift self-heals on the next run.

The canonical v1 milestone ids are:

- `accepted`
- `hydrated`
- `triaged`
- `reply_drafted`
- `ask_for_info`
- `proposal_ready`
- `escalation_proposed`
- `tracking_item_created`
- `spec_ready`
- `build_started`
- `review_requested`
- `change_request_created`
- `review_fixup`
- `human_gate`
- `outcome_observed`
- `final_outcome`
- `no_action`
- `monitor`

`StoryMilestoneId`, `ThreadStorySectionId`, `FeedStoryMilestoneKind`, and
`outbox_entry.metadata.milestone_kind` use the same canonical v1 milestone
vocabulary. Friendly copy such as "Dev escalation proposed" is derived from
`proposal_kind`; those labels are not accepted as data ids.

Existing issue-to-PR lifecycle gates map into the canonical ids as a hard cut:

- `signal` -> `accepted`
- `decision` -> `triaged`
- `spec` -> `spec_ready`
- `build` -> `build_started`
- `review` -> `review_requested`
- `pull_request` -> `change_request_created`
- `merge_gate` -> `human_gate`
- `outcome` -> `final_outcome`

Runtime input rejects legacy ids. Published legacy entries may refresh into the
canonical entry during migration lookup only, preserving `comment_id`, locator,
and receipt refs, then writing the canonical milestone id to the refreshed
entry.

core-only story/outbox metadata references the existing provider idempotency
contract rather than replacing it. This preserves the existing provider idempotency contract while giving core helpers stable replay metadata. The
idempotency key is built from source id,
provider, source-thread ref, workflow/run id, lane id, canonical milestone id,
target ref, proposal id, and content hash. The content hash is derived from the
normalized public markdown. A same-key replay updates or reuses the existing
publication; different milestones produce distinct entries and do not collide.

## Schema Decision

Keep the story as an internal typed helper plus stable outbox metadata for this
cut. Do not publish a standalone `@runxhq/contracts` schema yet.

That boundary is deliberate:

- current consumers are first-party tools and tests inside OSS runx
- the provider surface is the outbox entry, not a separate registry packet
- external adapters can already consume the rendered message and metadata
- delaying a public schema avoids freezing fields before live dogfood proves the
  final reviewer shape

Promote the packet to a public contract only when a non-tool consumer needs to
validate or exchange the story independently of the outbox entry. That promotion
must be a hard cut with call sites, docs, and tests updated in one change.

## Required Reviewer Sections

Public story markdown should summarize durable gates:

- source thread and request
- hydrated evidence status when adapter context was needed
- triage decision
- governed scafld task
- build result
- review verdict and finding counts
- PR link, branch, and base when known
- human merge gate
- observed merged or closed outcome

It should not publish low-level run events, full command dumps, raw provider
payloads, local absolute paths, token-shaped values, or consuming-repo policy
such as Slack channel names, Sentry project ids, or owner maps.

The public story carries concise status, evidence bullets, safe excerpts,
source-thread continuity, result refs, publication refs, and the exact next
human action. The private receipt and artifact refs carry raw provider payloads,
full command output, local paths, and detailed evidence for audit. Source-thread
publication is fail-closed: if policy requires a source-thread update and no
source-thread locator is present, helpers reject the projection instead of
falling back to a root channel. This keeps public comments idempotent and
reviewer-safe while preserving artifact refs for reconstruction.

## Non-goals

- This contract does not admit Slack, Sentry, or support-channel messages.
- This contract does not push outbox entries to providers; provider mutation is
  blocked on `thread-outbox-provider-protocol-v1`.
- This contract does not decide whether an issue deserves a PR.
- This contract does not merge PRs.
- This contract does not replace receipts, ledgers, or scafld status.
- This contract does not encode consuming-product, runner-provider, or hosted
  deployment policy.
