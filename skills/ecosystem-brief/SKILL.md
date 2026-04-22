---
name: ecosystem-brief
description: Produce an approved ecosystem briefing from bounded research and a governed content pass.
---

# Ecosystem Brief

This chain is the specialized daily-brief variant of `content-pipeline`.

It is for one decision-ready ecosystem update: what changed, why it matters,
and what the operator should do with that information. The output should feel
like a sharp daily brief, not a generic article.

## Inputs

- `objective` (optional): specific question for the market scan.
- `audience` (optional): who will read the brief.
- `channel` (optional): output channel; defaults to `brief`.
- `domain` (optional): ecosystem slice to monitor.
- `operator_context` (optional): decision context or evaluation lens for the brief.
- `target_entities` (optional): structured list of projects or companies the scan
  should compare or monitor.
