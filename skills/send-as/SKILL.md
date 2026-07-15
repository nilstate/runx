---
name: send-as
description: Plan and authorize a provider-neutral message or campaign send; this skill never delivers, so use a provider adapter for the actual send and its delivery evidence.
runx:
  category: ops
---

# Send As

Govern a message, campaign, or notification sent on behalf of a principal.

`send-as` is the planning and authority layer for the canonical
communication-action family. Provider adapter skills select concrete sending
surfaces and perform delivery; this skill owns the common authority
model: who is allowed to speak, to whom, through which channel, with what
content, under which proof, and where the send must stop for human approval.

## What this skill does

`send-as` produces a sealed send plan and authority request. It binds the
principal, provider, channel, recipients or audience, content digest, consent
basis, preflight checks, and approval gate. It refuses to treat a draft,
provider preview, or test message as live delivery. A live send is final only
after the provider-specific lane records delivery evidence and the runx receipt
seals.

This skill may be used directly for provider-neutral planning, or as the
canonical family beneath branded provider adapters. A sealed `send-as` receipt
means the plan was sealed. It never means the message was sent.

## When to use this skill

- An agent needs to plan or authorize a message before a concrete provider
  adapter sends or schedules it on behalf of a user, team, brand, account, or
  service.
- A provider-specific skill needs a shared authority model before it can call a
  send API or MCP tool.
- The workflow must prove the intended audience, content, consent basis, and
  approval decision before delivery.
- A review needs to distinguish draft, test, scheduled, approved, sent, denied,
  and failed states.

## When not to use this skill

- To write copy only. Use a drafting or brand-voice skill unless delivery is in
  scope.
- To prove delivery. Use the provider-specific adapter and require provider
  readback evidence; a `send_plan` is not a delivery receipt.
- To import contacts, enrich leads, verify domains, or configure billing as the
  main objective.
- To send without a named principal and audience.
- To hide provider credentials, raw contact lists, or customer data in the
  agent-visible output.
- To bypass unsubscribe, consent, suppression, warmup, preflight, legal, or
  human approval gates.

## Procedure

1. Identify the principal being represented and the provider account or surface.
2. Classify the send: `transactional`, `campaign`, `flow_step`, `support_reply`,
   `outreach`, `status`, or `internal`.
3. Bind channel and audience. Audience must be a named recipient, list, segment,
   support thread, channel, or scoped all-contacts decision; never an implicit
   broad default.
4. Bind content by digest or stable draft reference. Do not approve mutable
   content by prose summary alone.
5. Check consent, unsubscribe, suppression, compliance, preflight, and provider
   readiness. Missing evidence becomes a blocker.
6. Decide the gate:
   - drafts, previews, and test sends may proceed without live-delivery
     approval when provider policy permits them;
   - customer, public, audience, or live sends require explicit approval;
   - billing/account mutation is outside this skill and needs its own gate.
7. Produce the smallest provider-neutral `send_plan` that a branded skill can
   execute without widening authority.
8. Return `needs_input` for missing principal, audience, content digest, consent
   basis, or provider readiness; return `refused` for requested gate bypass.

## Edge cases and stop conditions

- **No principal:** return `needs_input`; the agent cannot speak as an unnamed
  actor.
- **No audience:** return `needs_input`; do not default to all contacts or a
  whole channel.
- **All contacts or broad audience:** require explicit reconfirmation and a
  stricter preflight block.
- **Mutable content:** return `needs_input` until content is digest-bound.
- **Missing consent or unsubscribe path:** block live delivery.
- **Preflight failure:** block provider send and preserve blocker evidence.
- **Approval denied or absent:** do not deliver.
- **Raw credentials or contact dumps:** redact; if redaction would remove the
  evidence needed to decide, return `needs_input`.

## Output schema

```yaml
send_plan:
  decision: ready | needs_input | denied | refused
  action_family: send-as
  principal:
    type: user | team | account | service
    ref: string
  provider:
    name: string
    account_ref: string
    runtime_path: string
  send_class: transactional | campaign | flow_step | support_reply | outreach | status | internal
  channel: email | sms | chat | push | webhook | other
  audience:
    type: recipient | list | segment | thread | channel | all_contacts
    ref: string
    requires_reconfirmation: boolean
  content:
    draft_ref: string
    digest: string
    subject_or_title: string
  gates:
    preflight_required: boolean
    human_approval_required: boolean
    approval_ref: string
  blockers: array
  provider_actions: array
  evidence_refs: array
  success_checkpoint:
    milestone: string
    description: string
```

## Worked example

Input: "Schedule the June newsletter to the subscribers list" with a campaign
draft digest, verified sender, named list, and provider account snapshot.

Output: `decision: ready`; `send_class: campaign`; audience is the named
subscribers list; content is digest-bound; preflight and human approval are
required; the provider actions are compose/review/test, then gated schedule.
No live send is authorized until the approval gate is satisfied.

## Inputs

- `objective` (required): bounded send or delivery objective.
- `principal` (required): who the message is sent as.
- `provider_context` (optional): provider/account readiness, connector, or MCP
  status.
- `audience` (optional): recipient, list, segment, thread, channel, or audience
  brief.
- `content_ref` (optional): digest, draft id, template id, campaign id, or
  stable content reference.
- `consent_basis` (optional): why the recipient/audience may receive this.
- `operator_context` (optional): approval posture, legal constraints, or extra
  guardrails.
