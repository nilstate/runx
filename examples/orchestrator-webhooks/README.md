# Orchestrator Webhook Templates

This example contains outbound webhook templates for workflow orchestrators.
They are templates, not live endpoints. Replace each example URL before use.

Use this when runx should perform governance and credential delivery, then call
an existing orchestrator workflow as the effect. The orchestrator workflow may
branch, notify, or fan out after receiving the webhook payload.

For first-party skill quality, prefer `skills/n8n-handoff` and
`skills/zapier-handoff`. Those skills wrap the same outbound idea with explicit
execution context, preflight validation, idempotency, scoped credentials, and
receipt expectations.

## Files

- `templates/n8n-webhook.manifest.json`: POST template for an n8n webhook.
- `templates/zapier-webhook.manifest.json`: POST template for a Zapier Catch Hook.
- `X.yaml`: a graph example wired to the n8n template name.

## Secret Delivery

The templates use `${secret:RUNX_N8N_WEBHOOK_TOKEN}` and
`${secret:RUNX_ZAPIER_WEBHOOK_TOKEN}` in HTTP headers. Deliver those with the
existing local credential flags:

```bash
RUNX_N8N_WEBHOOK_TOKEN=replace-me \
  runx skill ./examples/orchestrator-webhooks --json \
  --credential orchestrator:bearer:RUNX_N8N_WEBHOOK_TOKEN \
  --credential-scope orchestrator.n8n.workflow.invoke \
  --secret-env RUNX_N8N_WEBHOOK_TOKEN \
  --event-id n8n-demo-001 \
  --source runx \
  --payload '{"hello":"workflow"}'
```

Do not paste bearer tokens into the manifest file.

## Professional n8n Handoff Contract

Treat the n8n webhook as an orchestrator-to-orchestrator handoff, not a raw
HTTP dump:

- runx owns the bearer credential, policy decision, execution, and receipt.
- n8n owns the webhook trigger endpoint, workflow canvas, branching, fan-out,
  and downstream notifications.
- The template sends `x-runx-handoff-scope` and
  `x-runx-handoff-audience` headers and mirrors the same values in the JSON
  body as `handoff_scope` and `handoff_audience`.
- The n8n workflow should reject events whose bearer token, handoff scope,
  handoff audience, or `event_id` shape does not match the expected contract.
- Use `event_id` for receiver-side idempotency before branching or calling
  downstream systems.

For hosted connectors, this same shape becomes scoped API credentials:
`runs:write` to hand off work to runx, `runs:read` to poll the run, and
`receipts:read` to retrieve the proof.

## Boundaries

These templates do not add a hosted runx API, an inbound webhook listener, or
external resume. They are only outbound HTTP effects from a governed runx run.
