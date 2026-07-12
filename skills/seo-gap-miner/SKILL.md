---
name: seo-gap-miner
description: Review supplied site inventory and demand fixtures, then produce a read-only SEO gap report that routes viable gaps to draft-content.
runx:
  category: growth
---

# SEO Gap Miner

Turn a bounded site inventory and demand packet into a read-only SEO gap report.

This skill does not fetch SERPs, crawl a site, or invent demand numbers. It
works only from supplied inventory, supplied demand fixtures, and explicit
content policy. The output is a read-only judgment packet naming which content
gaps are real enough to draft next and which topics were dropped by policy.

## What this skill does

1. Read the supplied `site_inventory`, `demand_fixtures`, and `content_policy`.
2. Drop excluded topics and name the exclusion.
3. Match each grounded demand term against the page inventory.
4. Return ranked gap findings only when the fixtures support a priority order.
5. Name `draft-content` as the downstream dispatch lane for each accepted gap.
6. Stop at `needs_more_evidence` when demand is too thin to support a credible
   priority order.

## Core rules

- Read-only. No fetches, crawling, search calls, publishing, or mutation.
- Use only supplied evidence. If the packet does not name demand clearly enough,
  stop.
- Do not inflate opportunity. A weak signal stays weak.
- Excluded topics stay excluded even if they appear in demand fixtures.
- Every gap must name the exact demand signal and the missing or weak page.
- Every actionable gap routes to `draft-content`; this skill does not draft the
  page itself.
- It emits no proposal envelope and mints nothing.

## When to use this skill

- An operator already has a trusted inventory of current pages.
- Demand signals have already been gathered through a governed upstream lane.
- The goal is to decide what content should be drafted next, not to publish it.

## When not to use this skill

- When the site inventory is stale or missing.
- When the demand packet is anecdotal, unnamed, or too thin to prioritize.
- When the operator needs live SEO research; that must happen in a separate
  read-only collection lane first.

## Quality Profile

- Purpose: decide which SEO gaps are real enough to draft next.
- Audience: growth operators, content owners, and maintainers reviewing the
  receipt.
- Artifact contract: one decision plus zero or more evidence-backed gap
  findings.
- Evidence bar: every finding cites a named demand signal and a named missing or
  weak page.
- Voice bar: direct operator report, not marketing copy.
- Strategic bar: prefer the fewest high-confidence gaps over a long speculative
  backlog.
- Stop conditions: return `needs_more_evidence` with zero findings when demand
  is too thin or too ambiguous.

## Output schema (`seo_gap_report`)

```yaml
decision: ready | needs_more_evidence
gap_findings:
  - term: string
    demand_grounding: string
    page_verdict:
      status: missing | weak
      page: string
    priority:
      level: high | medium | low
      reason: string
    dispatch_target: draft-content
policy_exclusions:
  - term: string
    reason: string
blockers: [string]
needs_input: [string]
success_checkpoint:
  milestone: string
  description: string
```

## Worked example

If the demand packet names repeated comparison-search demand for `crm migration
checklist` and the inventory only has a broad services page that mentions
migrations in one paragraph, this skill returns a `missing` or `weak` page
finding with a high priority, cites the exact demand signal, and routes the
follow-up to `draft-content`. If the only demand is one vague note like `SEO
seems important`, the skill stops with `needs_more_evidence`.

## Inputs

- `site_inventory` (required): current pages with `url`, `topic`, and
  `coverage`.
- `demand_fixtures` (required): `terms[]` with `term`, `demand_signal`, and
  `source`.
- `content_policy` (required): `excluded_topics` and `priority_themes`.
