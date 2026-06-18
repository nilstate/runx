---
name: runx-operator
description: "Operate a runx-managed tenant from an agent or manager dashboard: inspect state, triage risks, prepare governed actions, route to the right skill lane, require approvals for consequential acts, and verify receipts after execution."
runx:
  category: ops
---

# Runx Operator

Operate a runx-managed tenant from a manager cockpit.

This skill is the umbrella operations layer. It turns a tenant snapshot, an
operator objective, and receipt-backed evidence into one safe operator packet:
what is happening, what needs attention, what can be checked read-only, what
requires approval, which governed lane should execute, and how success will be
verified.

It is not the authority. It does not replace `send-as`, `ledger`, `refund`,
`spend`, `messageboard`, `nitrosend`, or provider-specific skills. It routes to
them with the smallest sufficient context and stops before any consequential act
that lacks the right gate.

## What this skill does

`runx-operator` produces an operator packet for a manager dashboard or an agent
session. It reads tenant state, classifies findings, ranks the next action,
selects the governed lane, names blockers, writes the approval prompt when a
human decision is required, and states the receipt/effect/readback that will
prove success.

It is useful before an action and after an action:

- before action, it turns state into proposals and approval requests;
- after action, it checks whether the expected receipt and projection appeared.

## When to use this skill

- An operator asks an agent to manage a runx tenant or product.
- A dashboard needs an agent-readable plan from the current projected state.
- A runbook needs to decide between read-only checks, proposals, approval-gated
  actions, and post-action verification.
- A tenant-specific operator skill needs a generic cockpit spine instead of
  inventing its own action model.

## When not to use this skill

- To execute a live mutation directly. Route to the named governed lane.
- To bypass a human gate because the agent or UI believes the action is obvious.
- To replace a domain skill such as `send-as`, `nitrosend`, `messageboard`,
  `ledger`, `refund`, `spend`, or `least-privilege-auditor`.
- To operate from stale, missing, or unverifiable state while claiming readiness.
- To put secrets, private keys, raw customer lists, or provider dumps into the
  operator packet.

## Operating Model

Use one loop:

```text
snapshot -> findings -> proposals -> approval -> governed lane -> receipt -> projection
```

The manager dashboard and the agent must read the same state and emit the same
action families. A button click and an agent plan are different interfaces over
the same governed lane, not separate backdoors.

## Procedure

1. Scope the objective.
   - Identify the tenant, surface, time window, and whether the ask is
     read-only, proposal-only, or execution-prep.
   - If the tenant or objective is ambiguous, return `needs_input`.

2. Classify state from evidence.
   - Use `dashboard_snapshot`, `receipt_summary`, `effect_summary`, and
     `provider_status` when present.
   - Treat missing evidence as missing. Do not infer success from UI state alone.
   - Separate health, money, communications, provider mutations, access,
     deployment, and incident signals.

3. Route to governed lanes.
   - Audit questions route to `ledger`, `receipt-auditor`, `run-history-analyst`,
     or `least-privilege-auditor`.
   - Live communication routes through `send-as` and then a provider skill such
     as `nitrosend`.
   - Payment collection, payout, refund, chargeback, or target changes route to
     the matching payment lane.
   - Board/thread/provider actions route to `messageboard`, `github-sync`,
     `issue-intake`, `issue-to-pr`, or the product's tenant skill.
   - Deploy and config changes route to the product-owned deploy lane.

4. Decide gates.
   - Read-only checks: no human approval.
   - Drafts, dry-runs, previews, and reports: no live-action approval unless they
     expose private data or broaden authority.
   - Live sends, payouts, refunds, customer-visible posts, provider mutations,
     target changes, credential changes, deploys, destructive actions, and broad
     audience decisions: explicit approval required.
   - Missing approval means `awaiting_approval`, not "ready".

5. Produce the operator packet.
   - Lead with the few issues an operator should act on now.
   - Name the exact lane for each proposed action.
   - Include approval copy only when the operator could approve it safely.
   - Include verification steps that will prove the action happened.

6. Stop cleanly.
   - Return `needs_input` for missing tenant, objective, identity, authority,
     evidence, approval, or target.
   - Return `refused` for requests to bypass gates, hide material facts, leak
     secrets, spoof receipts, mark unsettled money as settled, or send without a
     principal/audience/content digest.

## Edge cases and stop conditions

- **No tenant or objective:** return `needs_input`; there is no safe operating
  frame.
- **No projection or receipt evidence:** return `needs_input` or `unknown`
  status; do not convert silence into `ok`.
- **Requested action has unknown consequence:** stop at `needs_input` with the
  missing lane/consequence classification.
- **Money, public send, deploy, credential, target, destructive, or provider
  mutation without approval:** return `awaiting_approval`.
- **Approval text is too broad to approve safely:** return `needs_input` with the
  exact missing amount, audience, target, network, provider, or effect.
- **User asks to skip a gate, hide a blocker, forge a receipt, or mark state
  settled without proof:** return `refused`.

## Reference Loading

Load only the reference needed for the objective:

- Payments, payouts, refunds, x402, Stripe, reconciliation:
  `references/payments.md`
- Email, campaigns, notifications, customer/public communication:
  `references/communications.md`
- Receipt verification, ledger, trust roots, after-action proof:
  `references/receipts.md`
- Provider health, deploys, webhooks, credentials, outages:
  `references/providers.md`
- Manager dashboard state, projections, and action catalog design:
  `references/dashboard.md`

## Output schema

Return one `operator_packet`:

```yaml
operator_packet:
  decision: ready | awaiting_approval | needs_input | no_action | refused
  tenant_ref: string
  objective: string
  mode: read_only | proposal | execution_prep | post_action_review
  dashboard:
    health: ok | degraded | blocked | unknown
    money: ok | needs_attention | blocked | unknown
    communications: ok | needs_attention | blocked | unknown
    providers: ok | needs_attention | blocked | unknown
    receipts: ok | needs_attention | blocked | unknown
  findings:
    - severity: info | warning | critical
      area: health | money | communications | providers | receipts | access | deploy
      summary: string
      evidence_refs: [string]
  proposals:
    - action_id: string
      lane: string
      reason: string
      inputs_summary: object
      consequence: read_only | draft | live_mutation | money_movement | public_send | deploy
      approval_required: boolean
      approval_prompt: string | null
      blockers: [string]
      verification:
        expected_receipt: string
        expected_effect: string | null
        readback: string
  ordered_next_steps:
    - step: string
      lane: string
      requires_confirmation: boolean
  refused_reasons: [string]
  needs_input: [string]
  success_checkpoint:
    milestone: string
    description: string
```

## Quality Bar

- Prefer one clear next action over a dashboard dump.
- Never bury a required approval in prose; put it in `approval_prompt`.
- Never expose tokens, API keys, raw customer lists, private wallet keys, or
  provider response dumps.
- Never claim a state is settled, sent, deployed, paid, or refunded without a
  receipt/effect/readback reference.
- Never widen authority because a dashboard widget would be convenient.
- Keep tenant-specific policy in tenant context. Keep this skill generic.

## Inputs

- `objective` (required): operator request, e.g. "check payments and unblock
  funding", "prepare a campaign send", or "review stuck receipts".
- `tenant_ref` (required): the tenant or product being operated.
- `dashboard_snapshot` (optional): JSON summary of current projected state.
- `receipt_summary` (optional): JSON or prose receipt/effect summary.
- `provider_status` (optional): JSON or prose provider health/account state.
- `approval_context` (optional): existing operator approvals, denials, or
  policy gates.
- `operator_policy` (optional): tenant-specific constraints and lane names.
- `requested_action` (optional): preselected action lane or dashboard action id.

## Worked example

Input: "Check Frantic payment readiness and tell me what to do next" with a
dashboard snapshot showing runx healthy, Base/Arbitrum/Polygon x402 targets,
three funded postings, no unfunded approved postings, and Stripe webhook status
`needs_review`.

Output: `decision: ready`, money status `ok`, providers status
`needs_attention`, one warning finding for Stripe webhook readiness, and one
proposal routing to `provider.webhook_check` with no money movement. It does
not propose marking anything funded, because no unfunded approved posting is
present and the latest x402 funding receipt is already verified.
