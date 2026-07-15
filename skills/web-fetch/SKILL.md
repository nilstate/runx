---
name: web-fetch
description: Fetch and extract one web source within an explicit allowlist, returning the content by digest with full provenance.
runx:
  category: research
---

# Web Fetch

Fetch one URL, prove it was allowed, extract the part the caller asked for, and
return that slice by digest with the provenance needed to trust it later.

## What this skill does

`web-fetch` resolves a single URL against a host allowlist, retrieves it,
extracts text, metadata, or links, and seals the result so a downstream step can
cite the fetch without re-fetching. It checks the final host against the
allowlist before and after redirects, retrieves up to `max_bytes`, and returns
the final URL, the HTTP status, a `content_digest` over the retrieved body, the
extracted slice, and a provenance block recording when it ran, every redirect
hop, and how many bytes it read. The body is referenced by digest; only the
extracted slice is inlined.

This is the primitive an agent reaches for when it has already decided which page
to read. The decision it makes easier is "can I read this page, and what did it
actually say", with the answer backed by a digest instead of a remembered
paraphrase. It differs from the research family: `research` and
`deep-research` decide *which* sources matter and synthesize across them,
while `web-fetch` retrieves exactly one source and refuses anything off the
allowlist.

## When to use this skill

- An agent has chosen a specific page and needs its content bound to a
  `content_digest` so a later step can cite it without re-fetching.
- A research pass needs each source retrieved through a single bounded
  `net:allowlist` fetch with a complete redirect chain and byte count.
- A review must later prove what a page said at fetch time.
- A follow-on skill (prior-art, vuln-scan, brief) needs one source extracted as
  `text`, `metadata`, or `links`.

## When not to use this skill

- To judge, rank, or synthesize across sources. That is the research family's
  job; `web-fetch` retrieves exactly one source and refuses to reason over many.
- To reach a host the caller did not declare in `allowlist`, including a host
  reached only through a redirect.
- To write anything. The only scope is `net:allowlist`; there is no repo, file,
  wallet, or send authority here.
- To inline a large raw body. The extracted slice is the payload; the full body
  lives behind `content_digest`.
- To carry secrets. Request headers may reference a credential by `${secret}`
  handle, but no header value, cookie, token, or auth string appears in the
  output or the receipt.

## Procedure

1. Require `url` and `allowlist`. Either missing returns `needs_agent`; the
   fetch cannot run without a target and a declared scope.
2. Match the URL host against `allowlist`. On a miss, return `policy_denied`
   before any network call, recording the attempted host and the allowlist it
   was checked against.
3. Fetch, following redirects, re-checking each redirect target's host against
   the same `allowlist`. A redirect that lands off-allowlist halts the fetch,
   returns `policy_denied` with the hop that failed, and discards partial
   bodies. Cap the read at `max_bytes` when set.
4. Compute `content_digest` over the retrieved body.
5. Extract per `extract`: `text` (readable body text, default), `metadata`
   (title, description, canonical, declared language, content type), or `links`
   (absolute hrefs found in the document).
6. Return `fetch_result` with the final URL, status, digest, extracted slice,
   and provenance. Flag truncated reads in provenance; never return a clipped
   read as if whole.

## Edge cases and stop conditions

- **Missing `url` or `allowlist`:** return `needs_agent`; the fetch has no target
  or no scope to check against.
- **Host off the allowlist:** stop with `policy_denied` before any network call;
  record the attempted host, not a response body (there is none).
- **Redirect off the allowlist:** halt the fetch, return `policy_denied` naming
  the hop that failed, and discard the partial body.
- **Read clipped by `max_bytes`:** flag `truncated: true` in provenance; the
  digest is over the bytes actually retrieved.
- **Large raw body:** never inline beyond the extracted slice; anything bigger
  than the requested view is reachable only through `content_digest`.
- **Credential in a header:** reference it by `${secret}` handle only; no header
  value, cookie, or token reaches the output or the receipt.

## Output schema

```yaml
fetch_result:
  decision: ready | needs_agent | policy_denied
  final_url: string            # URL after redirects, the one the digest is over
  status: number               # HTTP status of the final response
  content_digest: string       # digest of the retrieved body, algorithm prefix included
  extract_mode: text | metadata | links
  extracted: string | object | array   # string for text, object for metadata, array of hrefs for links
  provenance:
    fetched_at: string         # timestamp of the fetch
    redirects: array           # ordered host hops, each re-checked against the allowlist
    bytes: number              # bytes read
    truncated: boolean         # true when max_bytes clipped the read
  policy:
    allowlist_decision: allowed | denied
    attempted_host: string     # set on policy_denied
    allowlist_checked: array   # the hosts the request was checked against
```

The sealed `runx.receipt.v1` carries the final URL, status, `content_digest`,
byte count, the redirect chain, and the allowlist decision. It carries no header
values, no cookies, and no raw body beyond the digest.

## Worked example

Input: `url` of the HTTP Semantics RFC, an `allowlist` of `www.rfc-editor.org`
and `rfc-editor.org`, `extract: text`, and `max_bytes: 200000`.

Output: `decision: ready`; the host matched the allowlist before the request
left; no redirects; status `200`; `content_digest` is taken over the retrieved
body; `extracted` holds the readable text slice; provenance records
`fetched_at`, an empty redirect chain, `184302` bytes, and `truncated: false`.
The receipt seals with the final URL, status, digest, byte count, and the
allowlist decision; no header value reaches it.

## Inputs

- `url` (required): the single URL to fetch; its host must match the allowlist.
- `allowlist` (required): permitted hosts or host patterns; the URL and every
  redirect target must match an entry.
- `extract` (optional): `text`, `metadata`, or `links`. Defaults to `text`.
- `max_bytes` (optional): cap on bytes read; a clipped read is flagged
  `truncated` in provenance.
