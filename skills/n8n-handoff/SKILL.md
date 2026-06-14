---
name: n8n-handoff
description: Validate a runx execution context and hand off a governed payload to an n8n workflow webhook with scoped auth, idempotency, and receipt expectations.
runx:
  category: ops
---

# n8n Handoff

Hand off governed runx work to an n8n workflow without turning n8n into the
authority holder.

This skill is for the outbound side of the n8n integration story. runx owns the
policy decision, credential delivery, execution context, and receipt. n8n owns
its workflow webhook, canvas, branching, fan-out, and downstream notifications.

## Quality Profile

- Purpose: create a professional runx-to-n8n handoff with explicit execution
  context, receiver scope, audience, idempotency, and receipt expectations.
- Audience: operators wiring self-hosted n8n today, and hosted connector
  reviewers evaluating the same contract later.
- Artifact contract: emit a `handoff_context` artifact in preflight and
  `handoff_delivery` when the live webhook is called. The context artifact must
  include platform, event id, idempotency key, handoff scope, handoff audience,
  execution context, payload, receiver validation requirements, and receipt
  expectations. Do not introduce a separate packet family unless lifecycle state
  needs to move beyond the receipt.
- Evidence bar: the handoff must name the caller/workflow or principal,
  receiver audience, event id, and dedupe key. Missing or conflicting context is
  a stop condition.
- Voice bar: direct operator language; no generic automation claims and no
  claims that n8n endorses or lists runx before that is true.
- Strategic bar: prove orchestrator-to-orchestrator handoff while keeping
  provider secrets in runx and using n8n only as the workflow surface.
- Stop conditions: stop before the webhook call for missing origin context,
  malformed event ids, audience/scope mismatches, loopback receiver URLs,
  obvious raw credentials in payload/context, or missing bearer credential
  delivery.

## Runners

- `preflight`: validates and normalizes the handoff context without network.
- `send`: validates the context and posts the payload to the n8n webhook.

Use `preflight` for reviews, CI, and local harnesses. Use `send` only after the
n8n webhook URL and `RUNX_N8N_WEBHOOK_TOKEN` have been configured.

## Execution context

`execution_context` must identify where the handoff came from. Include at least
one of:

- `caller` or `caller_id`
- `principal` or `principal_id`
- `workflow`, `workflow_id`, `workflow_ref`, or `source_workflow`
- `upstream_execution_id` or `upstream_run_id`

When present, these fields must match the top-level inputs:

- `platform`
- `event_id`
- `idempotency_key`
- `handoff_scope`
- `handoff_audience`

## Edge cases

- Cloud n8n cannot call a local shell or localhost runx process. Use hosted runx
  APIs for public n8n listing work.
- Self-hosted n8n can receive local outbound webhooks, but the receiver endpoint
  still needs an operator-owned bearer token and idempotency check.
- Do not put raw provider credentials into `payload` or `execution_context`.
  Pass credential references or let runx hold the provider secret.
- If the workflow slug changes, update `handoff_audience` to the matching
  `n8n:workflow:<slug>` value.
- The receiver must dedupe by `event_id` before branching or sending downstream
  notifications.

## Inputs

- `event_id` (required): stable id for receiver-side dedupe.
- `execution_context` (required): explicit caller/workflow context.
- `payload` (required): business payload delivered to n8n.
- `handoff_audience` (optional): defaults to
  `n8n:workflow:runx-governed-effect`.
- `webhook_host` and `workflow_slug` (send runner): public n8n endpoint parts.
- `idempotency_key` (optional): defaults to `event_id`.
