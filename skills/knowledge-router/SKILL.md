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

Each route must name the supplied signal that justified its source match,
owner, escalation, and next-skill recommendation. Keep the result as a concise
dispatch note. Return `needs_more_context` when no route is supportable, and
`manual_review` for legal, billing, security, or destructive requests.

## Output

- `route`: selected knowledge or ownership domain and rationale.
- `source_matches`: relevant sources with the matching signal.
- `owner_recommendation`: owner or escalation target.
- `next_skill`: the bounded follow-up capability, if one is justified.

## Inputs

- `question` (required): user question, event, or thread summary to route.
- `available_sources` (required): source catalog, docs, systems, or owner map.
- `constraints` (optional): allowed systems, sensitivity, or preferred owner.
