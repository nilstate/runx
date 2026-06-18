# Operator Console

The operator console is the manager surface for a runx tenant. It is not a
second control plane. It is a projection plus an action catalog over the same
governed lanes an agent can use.

## Shape

```text
tenant projections -> runx-operator -> governed action lane -> receipt -> projection
```

The dashboard shows state. The agent explains and routes action. The runtime
enforces authority, approvals, receipts, and provider boundaries.

## Responsibilities

The console may show:

- health and deploy status;
- payment targets, quotes, settlements, payouts, refunds, and stuck effects;
- communication drafts, approvals, sends, and provider readiness;
- receipt publication and verification status;
- provider sync/webhook/credential health;
- access and least-privilege review state.

The console must not add bespoke mutation routes for convenience. A dashboard
button maps to a governed lane such as `send-as`, `ledger`, `refund`,
`messageboard`, `nitrosend`, `least-privilege-auditor`, or a tenant skill.

## Agent Contract

Use `runx-operator` when an agent is asked to manage a tenant. It reads the same
projection the UI shows and emits `runx.operator_packet.v1`:

- findings grounded in evidence;
- proposed governed lanes;
- approval prompts for consequential actions;
- blockers and missing inputs;
- receipt/effect/readback expectations.

The packet is a plan/proposal surface. Consequential work still executes through
the named lane and seals its own receipt.

## Gates

- Read-only status and audit: no approval.
- Drafts, dry-runs, previews, and reports: no live-action approval unless they
  expose private data or widen authority.
- Live sends, payouts, refunds, public provider mutations, target changes,
  credential changes, deploys, and destructive actions: explicit approval.
- Post-action success: receipt/effect/readback required.

## Tenant Policy

Product-specific operator skills, such as a Frantic operator package, should
provide tenant policy and vocabulary. They should not fork the dashboard model.
The core loop stays:

```text
snapshot -> findings -> proposals -> approval -> governed lane -> receipt
```
