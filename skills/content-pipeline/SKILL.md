---
name: content-pipeline
description: Research a topic, draft the content, and package the approved publication bundle.
runx:
  category: content
---

# Content Pipeline

This is the standard publish lane for runx-authored public content.

It keeps evidence collection, drafting, and publication packaging as separate
steps so the operator can approve one concrete draft before anything is turned
into a publish packet.

The research packet must support every substantive public claim. Draft in the
declared channel's vocabulary for its actual readers; do not turn the graph
trace into generic thought leadership. A useful result should change something
for the reader—understanding, a decision, trust, adoption, or a concrete
follow-up. Return `needs_more_evidence`, `needs_review`, or
`not_worth_publishing` when the topic is stale, duplicative, weakly supported,
or true but not useful.

## Output

- `research_packet`: bounded sources, verified claims, inference, and gaps.
- `draft_content`: the reader-facing artifact grounded in that packet.
- `approval_decision`: the operator's decision on the exact draft.
- `publish_packet`: approved content and channel metadata, never an implicit publish.

## Inputs

- `objective` (required): what the content should accomplish.
- `audience` (optional): intended reader or operator segment.
- `channel` (optional): publication channel; defaults to `blog`.
- `domain` (optional): ecosystem or market area to research.
- `operator_context` (optional): constraints, voice, or campaign context.
- `target_entities` (optional): structured list of products, projects, or
  actors the research pass should keep in view.
