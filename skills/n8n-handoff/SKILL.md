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

Use `preflight` for reviews, CI, and local harnesses; it never needs approval.
The `send` runner first calls native `control.prepare_handoff`, which validates
the execution identity and produces both the canonical `delivery` envelope and
the exact webhook request that carries it. One explicit graph gate approves
that exact request because native `http.execute` is policy-gated rather than
effect-owned; the HTTP tool then posts the approved request. There is no second
approval, package handoff parser, HTTP wrapper, or token-bearing manifest.

Because an n8n host may be self-hosted, bind the stored credential to that
exact HTTPS audience when configuring it:

```bash
printf '%s' "$N8N_WEBHOOK_TOKEN" |
  runx credential set n8n \
    --profile workflow \
    --auth-mode bearer \
    --audience https://n8n.example.com \
    --from-stdin
```

Then pass the same host without a scheme as `webhook_host`. Runx intersects
the request allowlist with the credential audience before sending. A bare
ambient `N8N_WEBHOOK_TOKEN` has no safe host binding for this dynamic-provider
case and therefore cannot authorize the HTTP call.

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

- Cloud n8n cannot call a local shell or localhost runx process. Use hosted runx
  APIs for public n8n listing work.
- Self-hosted n8n can receive local outbound webhooks, but the receiver endpoint
  still needs an operator-owned bearer token and idempotency check.
- A profile audience and `webhook_host` must name the same host. Runx rejects a
  mismatch before credential material reaches the HTTP transport.
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

`event_id` is also the Runx mutation idempotency key and the value delivered as
`idempotency_key`; there is no second retry identity that can drift from it.
