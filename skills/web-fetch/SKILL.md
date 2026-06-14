---
name: web-fetch
description: Fetch and extract one web source within an explicit allowlist, returning the content by digest with full provenance.
runx:
  category: research
---

# Web Fetch

Fetch one URL, prove it was allowed, extract the part the caller asked for, and
return that slice by digest with the provenance needed to trust it later.

This is the primitive an agent reaches for when it has already decided which page
to read. It does one bounded thing: resolve a single URL against a host
allowlist, retrieve it, extract text, metadata, or links, and seal the result so
a downstream step can cite the fetch without re-fetching. The decision it makes
easier is "can I read this page, and what did it actually say", with the answer
backed by a digest instead of a remembered paraphrase.

It is a single bounded fetch primitive (`net:allowlist`), not the research skill
that reasons over many sources. `research` and `deep-research-brief` decide
*which* sources matter and synthesize across them. `web-fetch` retrieves exactly
one, refuses anything off the allowlist, and hands back content plus provenance.
Compose many `web-fetch` results into a research pass; do not ask `web-fetch` to
judge them.

## What this skill does

`web-fetch` resolves the URL, checks the final host against the caller's
allowlist before and after redirects, retrieves up to `max_bytes`, and extracts
the requested view. It returns the final URL, the HTTP status, a `content_digest`
over the retrieved body, the extracted slice, and a provenance block recording
when it ran, every redirect hop, and how many bytes it read. The body is
referenced by digest. Only the extracted slice is inlined.

## What this skill refuses to do

- Fetch a host that is not in the allowlist, including a host reached only
  through a redirect. That returns `policy_denied`.
- Write anything. The only scope is `net:allowlist`; there is no repo, file,
  wallet, or send authority here.
- Inline a large raw body. The extracted slice is the payload; the full body
  lives behind `content_digest`.
- Judge, rank, or synthesize across sources. That is the research family's job.
- Carry secrets. Request headers may reference a credential by `${secret}`
  handle, but no header value, cookie, token, or auth string appears in the
  output or the receipt.

## Governance

- **Scope:** `net:allowlist` only. The fetch is permitted to reach exactly the
  hosts the caller declared and nothing else.
- **Preflight gate, `policy_denied`:** the requested URL's host is matched
  against `allowlist` before the request leaves. A miss stops the run with
  `policy_denied` and records the attempted host and the allowlist it was checked
  against, not the response body (there is none).
- **Redirect gate:** every redirect target is re-checked against the same
  allowlist. A redirect that lands off-allowlist halts the fetch and returns
  `policy_denied` with the hop that failed; partial bodies are discarded.
- **Receipt:** the sealed `runx.receipt.v1` carries the final URL, status,
  `content_digest`, byte count, the redirect chain, and the allowlist decision.
  It carries no header values, no cookies, and no raw body beyond the digest.

## Procedure

1. Require `url` and `allowlist`. Either missing returns `needs_agent`.
2. Match the URL host against `allowlist`. On a miss, return `policy_denied`
   before any network call.
3. Fetch, following redirects, re-checking each hop's host against `allowlist`.
   Cap the read at `max_bytes` when set.
4. Compute `content_digest` over the retrieved body.
5. Extract per `extract`: `text` (readable body text, default), `metadata`
   (title, description, canonical, declared language, content type), or `links`
   (absolute hrefs found in the document).
6. Return `fetch_result` with the final URL, status, digest, extracted slice, and
   provenance. Truncated reads are flagged in provenance.

## Output

- `fetch_result.final_url`: the URL after redirects, the one the digest is over.
- `fetch_result.status`: the HTTP status number of the final response.
- `fetch_result.content_digest`: digest of the retrieved body (algorithm prefix
  included), the stable reference for the fetched content.
- `fetch_result.extracted`: the requested slice. A string for `text`; a structured
  object for `metadata`; an array of hrefs for `links`.
- `fetch_result.provenance`: object with `fetched_at`, `redirects` (ordered host
  hops, each re-checked against the allowlist), `bytes` read, and a `truncated`
  flag when `max_bytes` clipped the read.

Large raw bodies are never inlined beyond the extracted slice. Anything bigger
than the requested view is reachable only through `content_digest`.

## Quality Profile

- Purpose: retrieve one allowlisted web source and return its content by digest
  with provenance complete enough to trust or replay the fetch.
- Audience: the agent or follow-on skill (research, prior-art, vuln-scan) that
  asked for this specific page and will cite it by digest.
- Artifact contract: `fetch_result` with `final_url`, `status`,
  `content_digest`, `extracted` (matching the `extract` mode), and `provenance`
  carrying `fetched_at`, `redirects`, and `bytes`.
- Evidence bar: the digest is over the body actually retrieved from `final_url`;
  the redirect chain is complete and each hop was allowlist-checked; a truncated
  read is flagged, never silently returned as if whole.
- Voice bar: terse interface output, not prose. The extracted text is the
  source's words, not a summary or paraphrase. No narration of the fetch.
- Strategic bar: a clean, digest-anchored fetch lets a research graph cite a
  source without re-fetching and lets a later review prove what a page said at
  fetch time.
- Stop conditions: `policy_denied` when the host (or a redirect target) is not in
  the allowlist; `needs_agent` when `url` or `allowlist` is missing.

## Inputs

- `url` (required): the single URL to fetch.
- `allowlist` (required): permitted hosts or host patterns; the URL and every
  redirect must match an entry.
- `extract` (optional): `text`, `metadata`, or `links`. Defaults to `text`.
- `max_bytes` (optional): cap on bytes read; a clipped read is flagged
  `truncated` in provenance.
