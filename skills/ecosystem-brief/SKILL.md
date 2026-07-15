---
name: ecosystem-brief
description: Produce an approved ecosystem briefing from bounded research and a governed content pass.
runx:
  category: research
---

# Ecosystem Brief

This graph is the specialized daily-brief variant of `content-pipeline`.

It is for one decision-ready ecosystem update: what changed, why it matters,
and what the operator should do with that information. The output should feel
like a sharp daily brief, not a generic article.

Lead with the operational implication, then show the sources, verified change,
inference, and uncertainty behind it. Connect a signal to product, catalog,
trust, distribution, or positioning only when the evidence supports that link.
Return `needs_more_evidence` for an unverifiable signal and
`not_worth_publishing` for a true update that gives the operator no useful next
posture.

## Output

- `ecosystem_brief`: what changed, why it matters, evidence, implications, and recommendation.
- `open_uncertainties`: claims or movement that remain unverified.
- `approval_decision`: review of the exact brief.
- `publish_packet`: approved brief and channel metadata.

## Inputs

- `objective` (optional): specific question for the market scan.
- `audience` (optional): who will read the brief.
- `channel` (optional): output channel; defaults to `brief`.
- `domain` (optional): ecosystem slice to monitor.
- `operator_context` (optional): decision context or evaluation lens for the brief.
- `target_entities` (optional): structured list of projects or companies the scan
  should compare or monitor.
