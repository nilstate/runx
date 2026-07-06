---
name: support-desk
version: "0.1.0"
description: Turn a bounded support thread plus docs and policy into the next safe operator move without sending messages or mutating support systems.
---
# support-desk

`support-desk` turns a messy customer support thread into the next safe operator
move. It reads a bounded support thread, public docs or source snippets,
customer context that has already been approved for support use, and a support
policy. It emits exactly one proposal lane:

- `reply_only` for a docs-grounded answer that still requires a human or send-as
  gate before delivery.
- `issue_intake_proposal` for a reproducible product bug or docs gap that should
  be handed to issue-intake.
- `followup_plan` when the customer needs more information or context before a
  safe answer exists.
- `manual_review` when the request depends on private account state, billing,
  security, abuse, legal, identity, or unsupported claims.

The skill never sends a customer message, opens an issue, mutates an account,
changes billing, changes permissions, or calls an external support system. It
only produces a cited decision packet that another governed lane can review.

## Inputs

- `support_thread`: array of support messages or a bounded object containing
  subject/body/messages.
- `docs_corpus`: optional array of public docs snippets with `id`, `title`,
  `url`, and `text`.
- `source_catalog`: optional alternative source list with the same shape as
  `docs_corpus`.
- `customer_context`: optional public-safe context such as plan, product area,
  region, or prior non-private summary.
- `support_policy`: optional policy fields:
  - `safe_reply_topics`
  - `issue_intake_keywords`
  - `sensitive_topics`
  - `product_name`
  - `support_signature`

## Decision rules

1. Normalize the support thread and summarize the request.
2. Treat billing, password, account access, security, abuse, legal, private
   state, payment, bank, identity, or credential requests as `manual_review`.
3. Match answerable claims only against supplied docs/source snippets.
4. Use `reply_only` only when at least one cited doc supports the answer and no
   sensitive/private-state topic is present.
5. Use `issue_intake_proposal` when the thread describes a reproducible product
   bug or docs gap and the packet can cite the thread and relevant docs.
6. Use `followup_plan` when the request is not sensitive but lacks enough docs or
   customer detail for a safe answer.
7. Keep unsupported facts in `followup_plan` or `manual_review`; do not invent
   account state or product behavior.
8. Record the lane rationale, confidence, citations, missing context, and
   side-effect boundary in the output.

## Output schema

The runner emits `runx.support_desk.v1`:

```json
{
  "support_summary": {
    "request": "Customer asks why domain verification is pending.",
    "message_count": 2,
    "customer_context_used": ["account_tier", "region"]
  },
  "context_findings": [
    {
      "claim": "Domain verification can remain pending during DNS propagation.",
      "citation": "docs-domain-verify",
      "source_url": "https://docs.example.test/domain-verification"
    }
  ],
  "decision": {
    "lane": "reply_only",
    "rationale": "The question is answerable from supplied DNS docs and does not require private account state.",
    "confidence": 0.86
  },
  "reply_only": {
    "subject": "Re: domain verification pending",
    "body": "...",
    "send_gate": "requires_human_or_send_as_approval"
  },
  "issue_intake_proposal": null,
  "followup_plan": null,
  "manual_review": null,
  "status": "ready",
  "evidence": {
    "side_effects": "none",
    "docs_used": ["docs-domain-verify"],
    "unsupported_claims": [],
    "sensitive_topics": [],
    "harness_case_names": ["docs-grounded-reply-only", "sensitive-billing-security-manual-review", "missing-thread-failure"]
  }
}
```

Exactly one proposal field is non-null. Every answerable claim includes a
citation to supplied docs or source snippets.

## Worked example

```bash
runx skill ./skills/support-desk \
  --runner support \
  --input-json support_thread='[
    {"role":"customer","body":"I added the DNS TXT record but verification is pending. What should I check?"}
  ]' \
  --input-json docs_corpus='[
    {"id":"docs-domain-verify","title":"Domain verification DNS checks","url":"https://docs.example.test/domain-verification","text":"Domain verification requires the exact TXT value and DNS propagation can take up to 24 hours."}
  ]' \
  --input-json support_policy='{"product_name":"ExampleDesk","safe_reply_topics":["dns","domain verification"]}' \
  --json
```

Expected result: `decision.lane = reply_only`, `context_findings` cites the docs,
and the reply remains a proposal gated by a downstream sender.

## Validation

Run from the repository root:

```bash
runx harness ./skills/support-desk
```

Expected harness cases:

- `docs-grounded-reply-only`: sealed, docs-grounded reply proposal.
- `sensitive-billing-security-manual-review`: sealed manual-review packet with
  no reply, no issue mutation, and no account or billing action.
- `missing-thread-failure`: failure stop when the required support thread is
  missing.

## Safety boundary

This skill is intentionally non-mutating. It does not authenticate to support
systems, inspect private accounts, issue refunds, reset passwords, send emails,
open tickets, create issues, or make legal/security decisions. It produces a
reviewable packet for another governed lane.

