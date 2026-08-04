---
name: nitrosend
description: "Operate a Nitrosend account through one governed Runx skill: inspect readiness and analytics, plan and apply campaign/flow/template/segment drafts, import consented contacts through inline or bulk CSV paths, and approve or deliver campaign, flow, and transactional email operations with provider readback."
runx:
  category: growth
---

# Nitrosend

Use this as the single public Runx surface for Nitrosend customer operations.
It calls the live Nitrosend MCP boundary through a bounded provider adapter;
API keys are delivered as credentials, never accepted as skill inputs or
returned in receipts.

This skill is not for Nitrosend customer-support administration or team Slack
work. Those are product-operator concerns owned by the Nitrosend repository.

## Choose the runner

- `status` (default): live account, brand, sender, domain, provider, warmup, and
  deliverability readiness.
- `configure-sender`: read, approve, update, and independently read back one
  explicitly selected brand's exact sender defaults. It configures no content,
  audience, campaign, flow, or delivery.
- `analytics`: live account, campaign, flow, or message insights.
- `review-delivery`: read-only content and preflight review. Flow review requires
  the exact immutable `revision_id`; campaigns and templates do not.
- `plan-campaign`, `plan-flow`, `plan-transactional`, and `plan-import`:
  bounded agent judgment that produces a reviewable request without provider
  completion.
- `compose-email`: read the live Nitrosend authoring contract, let one bounded
  agent author its exact next call, and return authoritative MCP validation.
  It never persists a draft or gains delivery authority.
- `apply-draft`: apply exact reviewed arguments for a campaign, flow, template,
  or segment draft. It never sends or activates.
- `approve-delivery`: approve a reviewed campaign or an exact flow revision
  without delivering.
- `send-campaign`: send or schedule an already-approved campaign after a fresh
  provider review and explicit approval.
- `activate-flow`: publish an exact already-approved flow revision after a
  fresh review and explicit approval.
- `send-transactional`: dry-run or send one idempotent message to one recipient.
- `import-contacts`: dry-run or import at most 100 inline consented records.
- `import-contacts-csv`: validate or upload a local CSV through Nitrosend's
  authorized direct-upload path. File bytes and signed URLs never enter the
  agent packet or receipt.
- `import-status`: make one bounded status read for an asynchronous import.
- `segment-from-prose`: internal planning lane for the current supported filter
  catalog; unsupported filters are rejected rather than approximated.

Use the current public `https://nitrosend.com/SKILL.md`, `nitro_get_status`, and
the live MCP schema as product truth. Do not copy onboarding or tool schemas
into another repo-local skill.

## Safe operating sequence

1. Run `status` and stop on sender, domain, suspension, warmup, or account
   blockers.
2. Correct sender defaults only through `configure-sender`. Supply the public
   brand SID even when the credential currently defaults to that brand, plus
   the complete sender name, sender address, reply-to address, saved test
   recipients, and a stable idempotency key. The runner reads the selected
   brand before approval and independently reads it again after mutation.
   A missing brand SID, different readback brand, or changed field stops the
   operation; never fall back to an account default.
3. For email authoring, use `compose-email` so Nitrosend supplies current brand
   and memory context before the model writes. Treat its MCP validation as
   authoritative; repair in another bounded turn when requested. For other
   planning, use the matching planning runner.
4. Apply only validated arguments through `apply-draft`; that separate runner
   retains the approval gate and is the first persistence boundary.
5. Run `review-delivery` before approval. For flows, carry the exact current
   `revision_id` unchanged through review, approval, and activation. Use
   `approve-delivery` separately so retries never combine approval-state
   mutation with recipient delivery.
6. Use `send-campaign` or `activate-flow` only after provider approval state is
   established. A fresh review and Runx approval gate are mandatory.
7. Give every sender update, real transactional send, campaign delivery, and
   import a stable
   idempotency key. Reuse that key after a timeout; do not mint a new one.
8. Treat completion as real only when the sealed receipt contains Nitrosend
   provider evidence. A plan receipt is not proof of send, schedule, activation,
   or import.

## Contact import rules

Every import requires a stable `source_id` and a plain-language
`consent_basis`. Purchased, scraped, or data-broker lists are refused.

For CSV imports, pass an absolute `.csv` path. The adapter computes metadata and
checksum locally, reserves an authorized upload, streams the file directly to
the returned public HTTPS host, finalizes with the signed ID, and discards the
signed URL. The import is asynchronous; call `import-status` again as needed
rather than keeping a resident polling loop.

## Stop conditions

- Missing provider credential or brand context.
- Missing explicit brand SID or incomplete sender defaults for a sender update.
- Sender readback that resolves another brand or differs from the exact request.
- Unsupported operation, audience, segment filter, or lifecycle transition.
- Missing consent source, recipient, schedule time, or idempotency key.
- Failed provider review or preflight.
- Missing or denied approval.
- Any request to expose credentials, signed upload URLs, raw contact files, or
  unbounded provider responses.
- Any claim of completion without provider readback evidence.

## Agent task contracts

The planning acts prepare exact downstream operations and never call the
provider. `compose-email-from-contract` is different: the enclosing graph has
already read authoritative MCP intent evidence, and the agent only authors a
candidate for the graph's read-only MCP validation. No agent act persists or
delivers.

The internal provider boundary emits `nitrosend.provider_evidence.v1` for both
successful and stopped operations. Consumers carry that packet unchanged;
they do not reconstruct a smaller result shape or infer completion from raw
transport output.

### `send-campaign`

Build one campaign plan from the objective, current account-status JSON, and
audience brief. Distinguish a campaign from a flow or transactional message.
Require an explicit bounded audience, compliant sender readiness, review before
approval, and a separate confirmation before send or schedule. Do not invent
list or segment ids and do not claim delivery from this planning runner.

### `build-flow-plan`

Build one event-triggered automation plan with a supported trigger and ordered
steps. Route one-off broadcasts to `send-campaign`; never disguise them as a
flow. Preview and creation may be planned before confirmation, but approval and
activation must remain a separate confirmed delivery-control operation.

### `send-transactional-plan`

Plan exactly one email or SMS to one named recipient. Require channel-specific
content, a stable idempotency key, dry-run validation, and confirmation before a
real send. Reject audience or list broadcasts and route those to
`send-campaign`.

### `compose-email-from-contract`

Read the `composition_intent` provider evidence supplied as the declared input
or current graph context. It must contain a successful Nitrosend result with a
composition contract, contract id, and next call. Return `campaign_candidate`
with `decision` (`ready`, `needs_input`, or `reject`), exact `arguments`,
`rationale`, and `blockers`.

For `ready`, begin from the contract's `next_call`, preserve its `contract_id`,
set `composition_mode` to `validate`, and fill only the requested creative
fields. Follow the supplied brand, memory, examples, hard constraints, design
mode, and repair guidance. Never reconstruct omitted context, invent claims,
add an audience or schedule, or request draft, approval, activation, testing,
or sending. If the intent evidence or required contract fields are missing,
return `needs_input` without fabricated arguments.

### `import-contacts-plan`

Plan only consented contacts with a stable source, consent basis, bounded record
count, channels, compliance checks, dry run, and confirmation before import.
Refuse purchased, scraped, or brokered lists. Choose inline import only for the
bounded inline path; use the CSV runner for larger local files, without copying
file contents or signed URLs into the plan.

### `segment-from-prose-plan`

Translate the brief only through filters and predicates present in
`filter_catalog_json`. Return a concrete `segment_request` when every condition
is representable. Reject unsupported event history, attribution, or compound
semantics rather than approximating them with superficially similar fields.
