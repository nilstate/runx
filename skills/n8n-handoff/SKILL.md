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
