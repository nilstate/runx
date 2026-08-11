---
name: n8n-handoff
description: Validate a runx execution context and hand off a governed payload to an n8n workflow through any compatible provider binding, with idempotency and receipt-backed readback.
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
- `send`: validates the context, invokes the selected n8n workflow, and reads the invocation back.

Use `preflight` for reviews, CI, and local harnesses; it never needs approval.
The `send` runner first calls native `control.prepare_handoff`, which validates
the execution identity and produces the canonical delivery envelope. It then
uses the provider boundary for `workflow.invoke`; that boundary owns the exact
approval, credential custody, idempotency, and provider operation. A separate
provider read verifies the same event and invocation reference. The binding may
be local or hosted and may target self-hosted or cloud n8n; the skill never
assumes who holds the credential.

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
- `idempotency_key` (bound to `event_id`)
- `handoff_scope`
- `handoff_audience`

The receiver gets the normalized `delivery` object, not an independently
reassembled copy of these fields. That object carries the business payload,
source context, exact handoff scope and audience, and idempotency binding the
receiver must validate before starting its workflow.

## Edge cases

- A compatible n8n binding must resolve the selected `webhook_host`; absence is
  an actionable preflight blocker, not permission to fall back to ambient HTTP.
- Self-hosted and cloud bindings must both dedupe `event_id` before branching.
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
- `webhook_host` and `workflow_slug` (send runner): exact n8n binding target and workflow selector.

`event_id` is also the Runx mutation idempotency key and the value delivered as
`idempotency_key`; there is no second retry identity that can drift from it.
