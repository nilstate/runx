---
name: nitrosend
description: Govern Nitrosend campaign, flow, transactional, audience, analytics, and email-design work from objective and account context, with all live sends and imports explicitly gated.
runx:
  category: growth
---

# Nitrosend

Govern Nitrosend work through explicit runners, with live delivery and contact
mutation behind human gates.

This is the public branded Nitrosend catalog skill for the `send-as` action
family. It is derived from the Nitrosend first-party skill suite and preserves
its core invariant: the agent may draft, review, test, analyze, and plan, but it
must not approve, schedule, send to a live audience, activate a live flow, or
import contacts without explicit operator confirmation.

## What this skill does

`nitrosend` is the branded package. Its runners are the concrete lanes:

- `send-campaign`: one broadcast campaign over `send-as`.
- `build-flow`: one event-triggered automation flow; dry-run first, activation
  gated.
- `send-transactional`: one single-recipient system message; dry-run and
  idempotency required, real send gated.
- `compose-email`: design and review one brand-applied email template; no live
  audience send.
- `analytics`: read-only account/campaign/flow performance report.
- `import-contacts`: dry-run contact import first; real import gated; purchased
  or scraped lists refused.
- `segment-from-prose`: translate one audience brief into the supported segment
  filter surface, or reject unsupported asks.

Each runner emits an ordered Nitrosend tool-call plan. It uses account/context
snapshots to skip completed setup, names blockers, and emits the exact human
confirmations required before any final delivery or contact mutation.

It plans work; it does not silently send, activate, or import. Live delivery and
real contact import are governed actions and must pass the confirmation gate
recorded in the receipt.

## When to use this skill

- The user wants to operate Nitrosend from an agent: campaign, flow,
  transactional, template, analytics, contact import, or segment planning.
- The agent has a recent `nitro_get_status` snapshot and needs the shortest safe
  path to a reviewable plan.
- The work should be drafted, reviewed, optionally test-sent or dry-run, then
  held for approval where it can affect recipients or contacts.
- A Nitrosend MCP session is available to execute the ordered `nitro_*` calls
  after the plan is approved.

## When not to use this skill

- To merge multiple unrelated Nitrosend jobs into one runner invocation. Choose
  one runner per objective.
- To verify DNS, configure billing, or perform account mutation as the main
  objective.
- To bypass the supported Nitrosend segment filter surface with guessed audience
  approximations.
- To send to `all_contacts` without the operator explicitly re-confirming that
  audience by name.
- To import purchased or scraped contact lists.
- To bypass account, domain, sender, unsubscribe, consent, warmup, dry-run,
  idempotency, suppression, or preflight gates.

## Procedure

1. Select exactly one runner from the objective. If more than one lane is
   requested, return `needs_input` with the split needed.
2. Read `account_status_json` from `nitro_get_status`. Trust the snapshot over
   assumptions, and name missing setup as blockers.
3. Resolve the lane-specific target: audience, trigger, recipient, template,
   analytics scope, import source, or segment filters. For `segment-from-prose`,
   use `filter_catalog_json` from the current `nitro://schema` resource; never
   rely on a remembered filter catalog.
4. Choose the smallest safe plan. For delivery lanes, choose `scheduled` over
   immediate live when the user is not unambiguous.
5. Build the shortest ordered tool-call plan:
   `nitro_set_brand_kit` if brand/address setup is incomplete;
   `nitro_manage_domains` if live delivery needs a verified domain;
   `nitro_configure_account` if sender defaults are missing;
   `nitro_compose_campaign`;
   `nitro_review_delivery`;
   optional `nitro_send_test_message`;
   confirmation-gated `nitro_control_delivery`.
   or the matching flow/template/import/analytics/segment tools for the selected
   runner.
6. Mark live `nitro_control_delivery`, flow activation, non-dry-run imports, and
   operator-initiated real transactional sends as `requires_confirmation: true`.
7. Return `needs_input` when required lane inputs are missing. Return `reject`
   when the ask relies on unsupported Nitrosend capability.
8. Do not include raw secrets, bearer tokens, API keys, contact CSV contents, or
   provider response dumps in the plan.

## Edge cases and stop conditions

- **Multi-lane ask:** return `needs_input` with the runner split; do not bundle
  campaign plus flow plus import into one plan.
- **Missing audience:** return `needs_input`; do not default to all contacts.
- **All contacts:** require explicit `confirm_send_to_all` and human
  re-confirmation before delivery.
- **Missing flow trigger or transactional recipient:** return `needs_input`.
- **Unsupported segment filter:** return `reject`; do not approximate with a
  weaker filter.
- **Purchased/scraped import:** return `reject`.
- **Domain or sender not ready:** include setup/preflight blockers and stop
  before approval.
- **Dry-run or preflight failure:** do not call the live mutation; surface the
  blocker.
- **Approval denied or missing:** stop with no live send.
- **User asks for fully autonomous live send:** return `refused` or
  `needs_input`; the send gate is not optional.

## Output schema

Each runner emits one packet:

- `campaign_plan`
- `flow_plan`
- `transactional_plan`
- `email_design`
- `analytics_report`
- `import_plan`
- `segment_plan`

Every packet includes `decision`, `ordered_tool_calls`, `human_actions`,
`blockers`, `needs_input`, `unsupported_requirements`, and
`success_checkpoint`. Any live send, flow activation, non-dry-run import, or
operator-initiated real transactional send must appear with
`requires_confirmation: true`.

## Worked example

Input: "Schedule our weekly newsletter to the subscribers list next Tuesday at
9am" plus a healthy account snapshot with verified domain and sender.

Output: `decision: ready`; ordered calls compose the campaign, review delivery,
optionally send a test, then stop at confirmation-gated
`nitro_control_delivery(action: schedule)`. The receipt proves the plan did not
authorize a live audience send by itself.

## Inputs

- `objective` (required): one bounded Nitrosend objective.
- `account_status_json` (required): JSON string from a recent
  `nitro_get_status` call for runners that need account state.
- `audience_brief`, `flow_brief`, `recipient`, `data`, `brand_brief`,
  `source_brief`, `records`, `scope`, `entity_id`, `period`,
  `segment_brief`, `segment_name`, `preview_only` (optional):
  runner-specific inputs.
- `filter_catalog_json` (required for `segment-from-prose`): the current
  `filters` object from `nitro://schema`.
- `operator_context` (optional): extra guardrails, approval posture, or
  scheduling constraints.
- `client_surface` (optional): caller surface, usually `runx_skill_cli` or
  `mcp_direct`.
