---
name: draft-content
description: Turn evidence and operator intent into publication-ready drafts and handoff packets.
---

# Draft Content

Write one bounded piece of content from supplied evidence and a clear objective.

This skill is for drafting useful public artifacts: ecosystem briefs, trust
reports, release notes, maintainer updates, or social posts. It should never
hallucinate evidence. If the evidence is thin, say so and narrow the claims.

Keep the content grounded in a specific audience, channel, and objective. The
job is not to sound expansive. The job is to be useful and publishable.

## Output

Draft runner:

- `content_brief`: framing for audience, angle, and constraints.
- `draft`: the main draft text or structured sections.
- `review_checklist`: what must be checked before publication.
- `distribution_notes`: channel-specific packaging guidance.

Package runner:

- `publish_packet`: channel-ready payload and metadata.
- `qa_checklist`: final quality gates for handoff or publishing.
- `handoff_notes`: operator notes, caveats, and next actions.

## Inputs

- `objective` (optional): what the content should accomplish.
- `audience` (optional): intended reader or viewer.
- `channel` (optional): blog, newsletter, GitHub comment, status post,
  advisory, Moltbook, or other outlet.
- `evidence_pack` (optional): structured evidence object from research or
  another skill.
- `voice_guide` (optional): tone or brand constraints.
- `draft` (optional): existing draft text when packaging or revising.
