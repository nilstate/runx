---
name: twitter
description: >-
  Govern X (Twitter) account work through three lanes: evidence reads, typed
  act plans for posting and account hygiene, and gated execution with per-act
  provider evidence. Nothing reaches a live timeline or mutates an account
  without an explicit approval recorded in the receipt.
runx:
  category: growth
---

# Twitter

One account, three lanes: read evidence, plan typed acts, execute an approved
plan.

This is the public branded X (Twitter) catalog skill for the `send-as` action
family. Its core invariant: the agent may read, audit, draft, and plan freely,
but every act that publishes to a public timeline or mutates the account stops
at a human approval gate, and the sealed receipt proves which acts ran, against
which plan digest, with which provider evidence.

Write for the operator who owns the account, the reviewer who approves a live
act, and downstream skills that consume the resulting packets. Keep each plan
to the smallest evidence-backed act set that satisfies the objective. Existing
post and user ids must come from supplied evidence, never memory or guesswork;
name missing evidence as a blocker.

## What this skill does

Three runners:

- `read`: collect account evidence from the live API or, preferred for bulk
  history, an X archive export file (`tweets.js`, `following.js`). Queries:
  `snapshot`, `posts`, `mentions`, `search`, `following`, `followers`. Emits
  `twitter.evidence.v1`. Read-only; no gate.
- `plan`: turn one bounded objective plus evidence into `twitter.plan.v1`, an
  explicit list of typed acts with rationale. A plan is a draft; it delivers
  nothing.
- `execute`: run an approved plan through the X API behind an approval gate,
  act by act, sealing per-act provider evidence into `twitter.execution.v1`.
  Rate-limit stops are clean: the packet names the remaining act ids and a
  re-run with `already_executed_act_ids` skips completed work.

Each runner emits exactly one packet for its lane: typed evidence with
provenance and a content digest, a bounded act plan with rationales and gates,
or provider outcomes bound to the executed plan digest.

The act vocabulary, with its consequence class:

| kind | consequence | params |
| --- | --- | --- |
| `post` | public_send | `text` |
| `reply` | public_send | `text`, `in_reply_to` |
| `quote` | public_send | `text`, `quote_of` |
| `thread` | public_send | `texts` (ordered, max 25) |
| `repost` | public_send | `post_id` |
| `delete_post` | live_mutation | `post_id` |
| `unfollow` | live_mutation | `target_user_id` |
| `mute` | live_mutation | `target_user_id` |
| `block` | live_mutation | `target_user_id` |
| `follow` | live_mutation | `target_user_id` |
| `like` | live_mutation | `post_id` |

Every kind is consequential, so every plan sets
`gates.human_approval_required: true`. `follow`, `like`, and `repost` are
engagement acts and share a hard cap of 10 per execution. Direct messages are
outside this skill.

## When to use this skill

- Promote a release, publish a thread, or reply to a mention on behalf of a
  named principal, with content bound verbatim in the plan.
- Audit an account's own post history or following list and prune it: bulk
  delete old posts, unfollow low-value accounts, against operator-stated
  criteria.
- Gather timeline, mention, or search evidence for downstream research,
  triage, or lead skills that consume `twitter.evidence.v1`.
- Route a `send-as` plan onto X as its provider delivery lane.

## When not to use this skill

- To send direct messages or manage DM conversations.
- To farm engagement: follow-churn, mass liking, coordinated reposting, or any
  volume pattern designed to game visibility. The engagement cap is not a
  budget to fill.
- To mention, reply to, or dogpile users who have not engaged with the
  principal, at volume.
- To operate an account the operator does not control, or to automate consumer
  account creation.
- To bypass the approval gate, the act caps, or the operator's spending limit
  on the pay-per-use API.

## Procedure

For the `plan` runner, build `twitter_plan` this way:

1. Hold one bounded objective. If the ask bundles unrelated jobs (a promo
   thread plus a follow purge), return `needs_input` with the split.
2. Ground every reference. Ids for `delete_post`, `unfollow`, `reply`,
   `quote`, `like`, `mute`, and `block` must come from `evidence_json` or an
   explicit operator-supplied id. If the evidence is missing or stale, name it
   as a blocker; never invent or approximate an id.
3. Write public content into the act params verbatim: the exact `text` or
   `texts` to publish, shaped by `brand_context` when supplied. Do not plan a
   summary of what will be written; approval binds the exact words.
4. Give every act a stable `act_id` (`act-001` onward), its `kind`, `params`,
   its `consequence` from the table, and a one-line `rationale` tied to the
   objective or the operator's stated criteria.
5. Apply `operator_policy` narrowly. A prune criterion like "no engagement and
   older than 2023" selects only posts the evidence shows meet it; borderline
   items go to `open_questions`, not into the act list.
6. Keep the plan small: at most 50 acts, at most 10 engagement acts, threads
   at most 25 segments. A larger job becomes staged plans.
7. Set `decision`: `ready` when acts are grounded and complete; `needs_input`
   for missing objective, principal, evidence, or content; `reject` for asks
   outside the vocabulary or inside the abuse boundaries.
8. Never place credentials, bearer tokens, raw API dumps, or third-party
   personal data beyond public ids and handles in the plan.

## Edge cases and stop conditions

- **Mixed objective:** return `needs_input` with the runner or plan split.
- **Id not in evidence:** blocker; the plan stays `needs_input`.
- **Prune criteria ambiguous:** select the unambiguous items, list the rest in
  `open_questions`.
- **Rate limit during read:** the evidence packet returns what it collected
  with `stop_conditions: ["rate_limited"]` and the reset time.
- **Rate limit during execute:** the execution packet lists
  `remaining_act_ids`; re-run with `already_executed_act_ids` after the reset.
- **Plan digest mismatch on execute:** the execution refuses with a named
  blocker; nothing runs, and the sealed receipt proves the refusal.
- **Approval missing or denied:** the execute graph stops at the gate.
- **Credentials missing:** clean `needs_input` stop naming the environment
  variables; never a half-configured call.
- **Fully autonomous live posting requested:** `reject`; the gate is the
  contract.

## Output schema

- `twitter.evidence.v1`: `decision`, `source` (`live` or `archive`), `query`,
  `account`, `items[]` (typed post or user records with metrics), `item_count`,
  `truncated`, `provenance` (`retrieved_via`, `request_count`,
  `content_digest`), `rate`, `blockers[]`, `stop_conditions[]`.
- `twitter.plan.v1`: `decision` (`ready`, `needs_input`, `reject`),
  `objective`, `principal`, `acts[]` (`act_id`, `kind`, `params`,
  `consequence`, `rationale`), `gates`
  (`human_approval_required`, `approval_ref`), `evidence_refs[]`,
  `open_questions[]`, `blockers[]`, `success_checkpoint`.
- `twitter.execution.v1`: `decision` (`executed`, `partial`, `stopped`,
  `refused`), `plan_digest`, `principal`, `results[]` (`act_id`, `kind`,
  `consequence`, `status`, `provider_ref`, `detail`), `remaining_act_ids[]`,
  `rate`, `blockers[]`, `success_checkpoint`.

## Worked example

Input: objective "delete my zero-engagement posts from before 2024",
principal `account:@example`, evidence from
`read(query: posts, archive_file: data/tweets.js)` showing three matching
posts, operator_policy "keep anything with replies".

Output: `decision: ready`; three `delete_post` acts, each carrying the post id
from the evidence and a rationale quoting its age and zero metrics;
`gates.human_approval_required: true`; one borderline post with two replies
listed in `open_questions`. Execution then stops at the approval gate, and the
sealed receipt binds the approved digest to the three deletions the provider
confirmed.

## Inputs

- `read`: `query` (required), `params`, `archive_file`, `max_items`, `auth`.
- `plan`: `objective` (required), `principal` (required), `evidence_json`,
  `operator_policy`, `brand_context`, `operator_context`.
- `execute`: `plan_json` (required), `plan_digest`,
  `already_executed_act_ids`, `max_acts`.

## Credentials and cost

Credentials are delivered per run through the runx credential envelope, never
as inputs and never as receipt material. Two materials exist:

- `TWITTER_USER_AUTH`: one JSON object holding `consumer_key`,
  `consumer_secret`, `access_token`, `access_secret` (OAuth 1.0a user
  context). Required for every mutation and for own-account reads. Deliver it
  with `runx skill . <runner> --credential twitter:oauth1_user:<material_ref>
  --credential-scope twitter:write --secret-env TWITTER_USER_AUTH` for
  mutations, or `--credential-scope twitter:read` for reads.
- `TWITTER_BEARER_TOKEN`: the app-context bearer token, enough for `search`
  and public reads. Deliver with `--credential twitter:bearer:<material_ref>
  --credential-scope twitter:read --secret-env TWITTER_BEARER_TOKEN`.
  Read-only runs should be handed only this material.

The invocation binds a non-secret credential envelope (provider, auth mode,
material ref, scopes) and the secret lives in the named environment variable
for the lifetime of the run only. The tool manifest's `env_allowlist` is the
second gate: only listed variables cross into the tool process, delivered or
not. Setting the variable directly in the environment also works for local
development.

The X API bills per request on current plans and a post containing a link
costs a large multiple of a plain one, so prefer archive exports for bulk
history, set a spending cap in the developer portal, and let `max_items` and
the act caps bound each run.
