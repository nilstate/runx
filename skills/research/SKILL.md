---
name: research
description: Produce bounded, source-backed research packets for product, ecosystem, and operator decisions.
---

# Research

Research one bounded question and turn it into a decision-ready packet.

This skill is for applied research, not open-ended browsing. It should answer
one practical question with evidence, tradeoffs, and explicit uncertainty:
which issue is worth tackling, what the ecosystem is doing, whether a proposal
is grounded, or what claims a public post can safely make.

Keep the scope tight. Summaries without evidence are not enough, but an
undirected literature review is also wrong. Prefer a small number of verified
claims that change the operator's decision.

## Operating rules

- State the objective in operational terms.
- Distinguish verified evidence from inference.
- Surface missing evidence instead of inventing it.
- Bound the result to a concrete deliverable: brief, issue recommendation,
  content outline, or publish/no-publish decision.

## Output

- `research_brief`: object with `objective`, `scope`, `summary`, and
  `open_questions`.
- `evidence_log`: array of evidence entries with `claim`, `source`,
  `confidence`, and `relevance`.
- `decision_support`: array of options or recommendations with rationale.
- `risks`: array of research or execution risks.

## Inputs

- `objective` (required): the question to answer.
- `domain` (optional): ecosystem, product area, or audience context.
- `deliverable` (optional): intended artifact, for example `daily brief`,
  `triage recommendation`, or `publish packet`.
- `operator_context` (optional): local constraints or strategic context.
- `target_entities` (optional): array or object naming repos, products,
  competitors, communities, or issues that bound the research.
