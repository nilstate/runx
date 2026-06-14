---
name: knowledge-router
description: Route a question or source event to the right knowledge sources, owners, and follow-up skill.
runx:
  category: ops
---

# Knowledge Router

Route one question, source event, or support thread to the right knowledge
sources and follow-up path.

This skill is for triage and routing, not answering the question directly. It
should tell a consuming graph where to look, who owns the domain, what evidence
is already available, and which next skill should run.

## Quality Profile

- Purpose: turn ambiguous context into a focused retrieval and ownership plan.
- Audience: operators, support leads, and downstream skill graphs.
- Artifact contract: route, source matches, owner/escalation recommendations,
  and next-skill suggestion.
- Evidence bar: every route names the supplied signal that justified it.
- Voice bar: dispatch note, not research prose.
- Strategic bar: reduce wasted retrieval and route sensitive work to humans.
- Stop conditions: return `needs_more_context` when no route is supportable and
  `manual_review` for legal, billing, security, or destructive requests.

## Inputs

- `question` (required): user question, event, or thread summary to route.
- `available_sources` (required): source catalog, docs, systems, or owner map.
- `constraints` (optional): allowed systems, sensitivity, or preferred owner.
