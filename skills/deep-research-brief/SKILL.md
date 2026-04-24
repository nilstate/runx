---
name: deep-research-brief
description: Produce an approved deep-research brief from bounded research, synthesis, and governed packaging.
---

# Deep Research Brief

This chain turns one important question into a decision-ready brief.

It is for research that needs more than a quick answer but less than an open-
ended report. The output should feel like an operator memo: what the answer is,
what evidence supports it, what remains uncertain, and what posture the reader
should take next.

Do not drift into a generic article, daily update, or trend recap. The point is
to help a human decide, not to narrate that research happened.

## Quality Profile

- Purpose: answer one high-signal question well enough to support a concrete
  product, ecosystem, or operator decision.
- Audience: a maintainer, operator, or reviewer who needs a bounded brief, not
  a generic explainer.
- Artifact contract: research packet, synthesized draft, approval decision, and
  publish packet.
- Evidence bar: separate verified evidence from inference, carry open questions
  forward, and avoid claims the packet cannot support.
- Voice bar: decision memo, not SEO copy, launch copy, or thought-leadership
  filler.
- Strategic bar: explain what the reader should monitor, do, defer, or
  investigate next.
- Stop conditions: return `needs_more_evidence` when the packet is too thin to
  support a recommendation and `not_worth_publishing` when the question is true
  but not decision-relevant.

## Inputs

- `objective` (optional): specific question the brief should answer.
- `audience` (optional): primary reader for the memo.
- `channel` (optional): final delivery channel; defaults to `brief`.
- `domain` (optional): product, ecosystem, or market slice to bound the work.
- `operator_context` (optional): local decision context or evaluation lens.
- `target_entities` (optional): structured list of products, projects,
  companies, or repos to keep in scope.
