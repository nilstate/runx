---
name: hacker-news-public-api
description: Fetch public Hacker News item and top-story evidence through a keyless connector runner with sealed receipt metadata.
runx:
  category: data
---

# Hacker News Public API

Fetch read-only Hacker News evidence from the official Firebase public API. The
skill is a keyless connector for public item metadata and top-story ids. It does
not scrape pages, authenticate as a user, vote, comment, submit stories, or read
private account state.

## What this skill does

`hacker-news-public-api` calls the public Hacker News Firebase endpoints through
a checked-in runner and emits a structured provider-evidence packet. The receipt
records the runner, inputs, process result, stdout, stderr, and sealed execution
metadata. The provider evidence includes the endpoint, response status, request
kind, selected id or limit, and the returned JSON payload.

## When to use this skill

- You need a sealed public data read for one Hacker News item by id.
- You need a bounded snapshot of current top-story ids.
- You are building a downstream research, monitoring, or summarization workflow
  that should preserve the provider source instead of relying on prose.
- You need a no-credential connector that can be dogfooded in CI or local
  harnesses.

## When not to use this skill

- To post, vote, flag, favorite, or otherwise mutate Hacker News state.
- To access a private account, private profile data, cookies, or session state.
- To scrape HTML pages when the public Firebase endpoint has the needed data.
- To treat ranking or story metadata as authoritative financial, medical, legal,
  security, or emergency advice.
- To fetch unbounded comment trees. Use a separate bounded crawler with explicit
  pagination and rate limits.

## Procedure

1. Choose the `item` runner when the caller provides a known Hacker News item
   id. Validate that `item_id` is a positive integer.
2. Choose the `topstories` runner when the caller needs a small snapshot of
   current story ids. Validate `limit` as an integer from 1 through 50.
3. Call only `https://hacker-news.firebaseio.com/v0/...` and require a 2xx JSON
   response.
4. Emit provider evidence containing the endpoint, provider name, request kind,
   and response payload.
5. Return `needs_input` before fetching if the requested id or limit is invalid.
6. Return `needs_more_evidence` if the provider returns non-JSON, a non-2xx
   status, a null item, or the request times out.
7. Preserve the sealed receipt reference when another skill uses the data.

## Edge cases and stop conditions

- **Missing or invalid `item_id`:** return `needs_input`; do not guess an id.
- **Missing or invalid `limit`:** default to 10 only when omitted; otherwise
  return `needs_input`.
- **Null item response:** return `needs_more_evidence`; the id may be deleted or
  unavailable.
- **Provider outage, timeout, or non-2xx response:** return
  `needs_more_evidence` and include the endpoint in stderr.
- **Mutation request:** refuse. This connector is read-only and carries no user
  authority.
- **Large traversal request:** return `needs_input` and ask for a bounded item
  list or a separate crawler skill.

## Output schema

```yaml
decision: ready | needs_input | needs_more_evidence | refused
connector: hacker-news-public-api
provider: hacker-news-firebase
request:
  kind: item | topstories
  endpoint: string
  item_id: string | null
  limit: integer | null
provider_evidence:
  http_status: integer
  fetched_at: string
  payload: object | array
receipt_refs: array
stop_conditions: array
```

## Worked example

Run the default `item` runner with `item_id: "8863"`. The runner fetches the
public Dropbox launch story JSON from the Hacker News Firebase API, verifies the
response is JSON, and emits a `ready` provider-evidence packet with the story id,
title, author, score, timestamp, URL, and child comment ids exactly as returned
by the provider.

## Inputs

- `item_id` (`item`, required): positive Hacker News item id.
- `limit` (`topstories`, optional): number of top-story ids to return, default
  `10`, maximum `50`.
