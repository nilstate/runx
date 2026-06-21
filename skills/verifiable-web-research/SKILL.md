---
name: verifiable-web-research
description: Turn supplied public source snapshots into a cited research answer with claim-level evidence.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: research
---

# Verifiable Web Research

Prepare a short research answer from bounded public source snapshots. The skill
does not browse the web itself. A caller must provide approved source snapshots
with URLs, excerpts, timestamps, and optional quotes. Every claim in the answer
must cite source ids.

## Procedure

1. Require a `research_question`.
2. Require enough `source_snapshots` to meet the policy floor.
3. Normalize each public source into a source table.
4. Extract concise evidence-backed claims.
5. Return `needs_more_evidence` instead of answering when sources are missing.
6. Emit a citation map and verification gaps for reviewer replay.

## Inputs

- `research_question`: the question being answered.
- `source_snapshots`: public source snapshots with `url`, `title`, `excerpt`,
  `observed_at`, and optional `quote`.
- `research_policy`: optional `min_sources`, freshness, and answer style.

## Outputs

- `answer`: concise answer built only from supplied sources.
- `claims`: claim objects with source ids.
- `source_table`: normalized public source metadata.
- `citation_map`: claim ids to source ids.
- `verification_gaps`: missing evidence or replay blockers.
- `evidence`: reproducibility metadata.

