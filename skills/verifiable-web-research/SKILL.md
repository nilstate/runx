---
name: verifiable-web-research
description: Research a question from live web sources with reproducible evidence trails, source provenance, and an independent verification guide.
runx:
  category: research
---

# Verifiable Web Research

Research a question from live web sources and produce a report where every claim
is backed by a verifiable evidence trail. The output includes source URLs,
access timestamps, content digests, and a verification guide so an independent
reviewer can reproduce the findings.

This skill is for research that must be auditable. Unlike `research` (which
accepts pre-known sources) or `web-fetch` (which retrieves a single URL),
`verifiable-web-research` drives the full loop: discover relevant sources on the
open web, retrieve each one with provenance, extract claims, and package the
result with enough detail for an independent party to verify every assertion
without trusting the original agent.

## When to use this skill

- A decision depends on claims that currently live on the open web and needs
  evidence trails that survive scrutiny.
- A reviewer, auditor, or downstream consumer must be able to independently
  reproduce the findings by re-fetching the same sources.
- The research output will be cited in public content, governance documents, or
  compliance artifacts and must carry provenance.
- An operator wants a structured comparison of web-sourced facts (pricing,
  features, claims, status) with explicit confidence levels.

## When not to use this skill

- To fetch a single known URL. Use `web-fetch` instead.
- To research from local files or pre-collected evidence packs. Use `research`
  or `deep-research-brief`.
- To produce marketing content, blog posts, or narrative prose. Use
  `draft-content`.
- To scan for vulnerabilities. Use `vuln-scan` or `ecosystem-vuln-scan`.

## Verification levels

The skill supports three verification levels, each adding progressively more
reproducibility evidence:

### basic

- Each claim includes: source URL, fetch timestamp, and a direct quote or
  extract from the source.
- A verification guide lists all source URLs with instructions to re-fetch
  and confirm the claim still holds.
- Sufficient for internal decisions and low-stakes research.

### detailed (default)

Everything in `basic`, plus:

- Content digest (`sha256`) over each fetched source body so a reviewer can
  confirm they are reading the same content the agent read.
- The exact extract used for each claim (not just a paraphrase).
- Confidence level per claim (`verified`, `likely`, `uncertain`) with the
  reasoning behind the classification.
- Fetch metadata: HTTP status, final URL after redirects, byte count.
- Sufficient for public-facing claims and governance documents.

### audit_ready

Everything in `detailed`, plus:

- Full redirect chain for every fetch.
- Raw fetch headers captured (excluding credentials).
- A structured `evidence_archive` object containing every source's metadata,
  extract, and provenance in a single machine-readable block.
- A `replay_instructions` section that specifies the exact commands or tool
  calls an independent party would use to reproduce the full research from
  scratch.
- Sufficient for compliance artifacts, legal review, and published research.

## Procedure

1. Parse the research objective and scope. If `objective` is missing, return
   `needs_agent`.
2. Identify relevant web sources. Use the `target_entities` and `domain`
   inputs to bound the search. Prefer primary sources (official docs, release
   pages, API references) over secondary commentary.
3. For each source, fetch with full provenance:
   - Record the original URL, the final URL after redirects, the HTTP status,
     and the byte count.
   - Compute `content_digest` over the retrieved body.
   - Extract the relevant text, metadata, or data points.
4. For each claim in the output:
   - Bind it to the specific source URL and the exact extract that supports it.
   - Assign a `confidence` level with reasoning.
   - Record the `accessed_at` timestamp.
5. Generate the verification guide appropriate to the chosen `verification_level`.
6. Package the result as `verifiable_research_packet` with provenance,
   evidence log, and verification guide.

## Edge cases and stop conditions

- **Missing `objective`:** return `needs_agent`; the skill cannot determine
  what to research.
- **No sources found:** return `needs_more_evidence` with a description of
  what was searched and why nothing was found. Do not fabricate sources.
- **Source unreachable:** record the fetch failure in the evidence log with
  the attempted URL and error. Continue with remaining sources.
- **Content behind paywall or auth:** record as `access_denied` in the
  evidence log. Do not attempt to bypass access controls.
- **Source content has changed since fetch:** this is expected. The
  `content_digest` and `accessed_at` timestamp let a reviewer detect this.
  The verification guide should note that content may have changed.
- **Conflicting sources:** surface the conflict explicitly in the evidence log.
  Do not silently pick one source. Assign lower confidence to claims supported
  by only one source when another source contradicts it.

## Output schema

```yaml
verifiable_research_packet:
  objective: string
  scope: string
  verification_level: basic | detailed | audit_ready
  summary: string
  claims:
    - claim: string
      source_url: string
      final_url: string
      accessed_at: string
      content_digest: string          # detailed+ only
      extract: string                 # the exact text from the source
      confidence: verified | likely | uncertain
      confidence_reasoning: string
      http_status: number             # detailed+ only
      bytes: number                   # detailed+ only
  open_questions: array
  verification_guide:
    overview: string
    steps:
      - action: string
        target: string
        expected: string
    replay_instructions: object       # audit_ready only
  evidence_archive:                   # audit_ready only
    sources:
      - url: string
        final_url: string
        fetched_at: string
        content_digest: string
        status: number
        redirects: array
        bytes: number
        headers: object
        extract: string
```

## Inputs

- `objective` (required): the research question to answer from web sources.
- `domain` (optional): topic area or industry to bound the search.
- `verification_level` (optional): `basic`, `detailed`, or `audit_ready`.
  Defaults to `detailed`.
- `target_entities` (optional): array of specific products, companies, repos,
  or topics to focus the research on.
- `max_sources` (optional): maximum number of web sources to fetch. Defaults
  to 10.
- `operator_context` (optional): additional constraints or context that
  shapes which sources matter and how to interpret findings.
