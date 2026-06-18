---
name: verifiable-web-research
description: Conduct web research with reproducible evidence trails and verifiable citations.
runx:
  category: research
---

# Verifiable Web Research

Conduct web research with reproducible evidence trails and verifiable
citations.

This skill goes beyond普通 research by producing a complete evidence chain
that can be independently verified. Every claim includes a source URL,
access timestamp, and content snapshot. The output is designed for
situations where research quality must be provable: compliance reports,
due diligence, content fact-checking, and audit trails.

Use this when you need research that can withstand scrutiny — where
someone else can follow your trail and verify every claim.

## Operating rules

- Cite every claim with a URL, access date, and content excerpt.
- Snapshot page content at access time to prevent link rot.
- Distinguish primary sources from secondary reporting.
- Flag when sources conflict and present both sides.
- Include methodology notes explaining how each source was found.
- Produce a verification guide that lets others reproduce the research.

## Quality Profile

- Purpose: produce research with a verifiable evidence chain that can be
  independently audited.
- Audience: compliance officers, auditors, editors, and anyone who needs
  to trust the research findings.
- Artifact contract: `research_findings`, `evidence_chain`, `methodology`,
  and `verification_guide` with full source attribution.
- Evidence bar: every claim must have a primary source with URL and
  access timestamp. Secondary sources must be clearly labeled.
- Voice bar: precise, audit-ready prose. Every statement must be
  supportable by the evidence chain.
- Strategic bar: the verification guide must enable someone else to
  reproduce the research in under 30 minutes.
- Stop conditions: return `insufficient_evidence` when primary sources
  cannot be found, and return `conflicting_sources` when key claims
  have contradictory evidence.

## Output

- `research_findings`: array of findings with claims, evidence, and
  confidence levels.
- `evidence_chain`: array of source entries with URLs, access dates,
  content excerpts, and relevance scores.
- `methodology`: description of research approach, search terms, and
  source selection criteria.
- `verification_guide`: step-by-step instructions for reproducing the
  research.

## Inputs

- `question` (required): the research question to answer.
- `scope` (optional): boundaries for the research (time range, geography,
  topic area).
- `source_requirements` (optional): minimum number of independent sources
  per claim.
- `verification_level` (optional): depth of evidence chain (`basic`,
  `detailed`, `audit-ready`).
- `output_format` (optional): output format (`report`, `json`, `markdown`).
