---
name: verifiable-web-research
description: Build an auditable web research packet where each claim is tied to source metadata, exact extracts, and replay guidance.
runx:
  category: research
---

# Verifiable Web Research

Create a bounded research packet from web-source evidence with enough
provenance for an independent reviewer to replay the work. The skill turns a
research objective plus fetched source snapshots into claims, direct extracts,
content digests, and verification steps.

Use this when a downstream decision depends on web claims that must be checked
later. Use `web-fetch` when the caller already knows a single URL. Use
`research` when provenance is useful but digest-level replay is not required.

## Inputs

- `objective` (required): the question the evidence packet must answer.
- `source_fixture_path` (required): package-relative JSON fixture containing
  source snapshots. The deterministic publish harness may use
  `builtin:ai-agent-frameworks` when external fixture files are unavailable.
- `verification_level` (optional): `basic`, `detailed`, or `audit_ready`.
  Defaults to `detailed`.
- `max_claims` (optional): maximum number of evidence claims to include.
- `output_dir` (optional): package-relative directory for `evidence.json` and
  `report.md`.

## Source fixture contract

The fixture is a JSON object:

```json
{
  "sources": [
    {
      "url": "https://example.com",
      "final_url": "https://example.com",
      "fetched_at": "2026-06-22T00:00:00Z",
      "status": 200,
      "content": "Source text",
      "extracts": [
        { "claim": "Claim text", "quote": "Exact supporting quote" }
      ]
    }
  ]
}
```

The runner never reaches the network. It operates on already-fetched public
snapshots so verification can be deterministic and safe in harness runs.

## Procedure

1. Validate the objective, fixture path, and verification level.
2. Load the fixture from inside the skill directory.
3. For each source, compute `sha256` over the captured content.
4. Convert each extract into a claim record with source URL, final URL,
   accessed timestamp, digest, exact quote, and confidence.
5. Produce a verification guide explaining how to re-fetch the URLs and compare
   fresh content against the stored extracts and digests.
6. Write optional artifacts and print the packet as JSON.

## Output

The runner emits `verifiable_research_packet`:

```yaml
schema: runx.verifiable_web_research.result.v1
data:
  objective: string
  verification_level: basic | detailed | audit_ready
  summary: string
  claims:
    - claim: string
      source_url: string
      final_url: string
      accessed_at: string
      content_digest: string
      extract: string
      confidence: verified | likely | uncertain
      confidence_reasoning: string
  verification_guide:
    overview: string
    steps: array
  evidence_archive:
    sources: array
```

`basic` omits the evidence archive. `detailed` includes source digests and
claims. `audit_ready` includes replay commands and every source record.
