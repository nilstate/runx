---
name: docs-scan
description: Scan one explicit repository target for Sourcey-compatible docs inputs and preview fit.
---

# Docs Scan

`docs-scan` is the single-target analysis primitive for Sourcey adoption.

It does not crawl, rank, publish, contact maintainers, or open pull requests.
It inspects one explicit repository root, detects the incumbent docs stack,
discovers Sourcey-compatible inputs, scores the current docs surface, and emits
a bounded `docs_scan_packet`.

Use it before any preview, publication, or outreach decision.

## Inputs

- `repo_root`: local repository root to inspect.
- `repo_url` (optional): canonical repository URL when known.
- `docs_url` (optional): current public docs URL when known.
- `default_branch` (optional): default branch for the target.
- `objective` (optional): operator intent for this scan.
- `scan_context` (optional): extra bounded operator context.

## Output

The default runner emits a `runx.docs_scan.v1` packet with:

- `target`
- `repo_profile`
- `stack_detection`
- `docs_input_candidates`
- `quality_assessment`
- `preview_recommendation`

## Constraints

- Inspect only the explicit target root.
- Stay deterministic and bounded.
- Do not mutate the repo.
- Do not assume network access.
- Treat this as reviewable intake for later Sourcey preview work, not as a PR lane.
