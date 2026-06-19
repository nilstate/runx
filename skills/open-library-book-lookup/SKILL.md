---
name: open-library-book-lookup
description: Query the Open Library public search API through a bounded connector action and seal a receipt-safe book lookup result.
---

# Open Library Book Lookup

Use this skill when an agent needs a small, read-only book lookup from Open
Library with explicit authority, typed inputs, and receipt-safe output.

The skill models Open Library as a connector provider. The governed action is
`open_library.search`: it performs one bounded search against the
`/search.json` surface, or against a checked-in connector fixture during
harness replay. The result records provider metadata, request policy, stable
work identifiers, and a digest of the observed payload. It never mutates Open
Library, never uses credentials, and never stores raw user-private data.

## Authority

- Provider: `open-library`
- Connector path: Nango-compatible public connector dependency
- Scope: `open-library:search:read`
- Allowed host: `openlibrary.org`
- Allowed path: `/search.json`
- Allowed method: `GET`

Any requested host, path, method, or scope outside that policy is refused by the
skill contract before a provider call is attempted.

## Inputs

- `query`: required search string.
- `limit`: optional integer, default `3`, maximum `10`.
- `fixture_path`: optional package-relative JSON fixture. Harness runs use this
  so the receipt is deterministic and public.

## Output

The runner emits `open_library_search_result` as packet
`runx.open_library.search_result.v1`.

Key fields:

- `decision`: `ready` when the bounded read completed.
- `provider`: `open-library`.
- `connector`: declared connector dependency and scope.
- `request`: normalized endpoint, method, query, and limit.
- `result`: compact book records with Open Library work keys.
- `provenance`: source mode, payload digest, and fixture/live metadata.
- `policy`: allowlist decision and non-mutation guardrails.

## Harness

The checked-in harness fixture uses `fixtures/open-library-search-response.json`
to exercise the connector path without a live network dependency. A passing
run proves the `X.yaml` runner, typed inputs, output packet, emitted artifact,
and receipt sealing all work from the package.

