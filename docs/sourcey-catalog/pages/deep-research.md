# deep-research

- Group: Research and data
- Source: [skills/deep-research/SKILL.md](https://github.com/runxhq/runx/blob/5afc25a83edf1c1320df7ac0d78c36f1523b5677/skills/deep-research/SKILL.md)
- Commit: `5afc25a83edf1c1320df7ac0d78c36f1523b5677`
- Path: `skills/deep-research/SKILL.md`

# Deep Research Brief

This graph turns one important question into a decision-ready brief.

It is for research that needs more than a quick answer but less than an open-
ended report. The output should feel like an operator memo: what the answer is,
what evidence supports it, what remains uncertain, and what posture the reader
should take next.

Do not drift into a generic article, daily update, or trend recap. The point is
to help a human decide, not to narrate that research happened.

Separate verified evidence from inference and carry unresolved questions into
the memo. The synthesis must say what the reader should monitor, do, defer, or
investigate next. Return `needs_more_evidence` when the packet cannot support a
recommendation, and `not_worth_publishing` when the answer is sound but does not
matter to the stated decision.

## Output

- `research_packet`: bounded evidence, confidence, inference, and open questions.
- `brief_draft`: the decision memo synthesized from that packet.
- `approval_decision`: review of the exact brief and its remaining uncertainty.
- `publish_packet`: approved brief and delivery metadata.

## Inputs

- `objective` (optional): specific question the brief should answer.
- `audience` (optional): primary reader for the memo.
- `channel` (optional): final delivery channel; defaults to `brief`.
- `domain` (optional): product, ecosystem, or market slice to bound the work.
- `operator_context` (optional): local decision context or evaluation lens.
- `target_entities` (optional): structured list of products, projects,
  companies, or repos to keep in scope.
