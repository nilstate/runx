---
name: crossref-work-lookup
description: Search Crossref for scholarly works through a bounded, read-only connector and return compact DOI metadata with provenance.
runx:
  category: research
---

# Crossref Work Lookup

Use this skill to find scholarly works by title, author, or topic without
granting mutation authority. It returns a compact set of DOI records and binds
the provider response to a digest for auditability.

## Procedure

1. Accept a non-empty search query and a result limit from 1 to 10.
2. Use only the declared Crossref `works` read scope.
3. Permit only `GET https://api.crossref.org/works`.
4. Normalize titles, authors, DOI, publication year, and resource URL.
5. Emit a `runx.crossref.work_search_result.v1` packet with request provenance.
6. Stop on malformed provider data or any attempted mutation.

## Safety

- Never sends credentials, private user data, or write requests.
- Never follows provider URLs returned inside records.
- Fixture mode is deterministic and intended for governed harness runs.

