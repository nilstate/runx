---
name: zapier-handoff
description: Validate a runx execution context and hand off a governed payload to a Zapier Catch Hook with scoped auth, idempotency, and receipt expectations.
runx:
  category: ops
---

# Zapier Handoff

Hand off governed runx work to a Zapier Catch Hook while keeping authority,
provider credentials, and receipts in runx.

This skill is for the outbound side of the Zapier integration story. It is not
the public Zapier App Directory app; that app should call hosted runx APIs. This
skill gives the same execution-context contract to local dogfood and any
operator-owned Zap that receives governed effects from runx.


## Runners

- `preflight`: validates and normalizes the handoff context without network.
- `send`: validates the context and posts the payload to the Zapier Catch Hook.

Use `preflight` for reviews, CI, and local harnesses. Use `send` only after the
Zapier Catch Hook path and `RUNX_ZAPIER_WEBHOOK_TOKEN` have been configured.

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

- Public Zapier directory work must use hosted HTTPS runx APIs, not a local
  Catch Hook template.
- Do not include payment, token-transfer, or settlement actions in public Zapier
  v1. This local skill can model a hook handoff, but the public app must stay
  non-payment until review constraints are satisfied.
- Do not put raw provider credentials into `payload` or `execution_context`.
  Pass credential references or let runx hold the provider secret.
- Zapier may retry or replay hook deliveries. The Zap must dedupe by `event_id`
  before downstream actions.

## Inputs

- `event_id` (required): stable id for receiver-side dedupe.
- `execution_context` (required): explicit caller/workflow context.
- `payload` (required): business payload delivered to Zapier.
- `handoff_audience` (optional): defaults to
  `zapier:zap:runx-governed-effect`.
- `zapier_account_id` and `zapier_hook_id` (send runner): Catch Hook path
  segments.
- `idempotency_key` (optional): defaults to `event_id`.
