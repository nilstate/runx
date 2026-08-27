---
name: github-pr-comment
description: Post one exact GitHub pull-request comment through local gh, any compatible hosted connector, or the explicit human-gated MCP composition, with retry safety and independent readback.
runx:
  category: code
---

# GitHub PR Comment

Post one bounded review comment to one known GitHub pull request. The skill is
deliberately narrower than a general GitHub operator: it binds the exact
repository, pull request, and comment body to a scoped provider operation, and
closes only when provider evidence identifies and reads back the created note.

Use it after a review workflow has produced final wording and the operator wants
that exact note posted. Use `issue-triage` for analysis and drafting, and a
broader GitHub skill for other resource types. This skill never merges a pull
request; comment authority cannot be promoted into merge authority.

## Composes

<!-- Generated from the native execution closure; run pnpm core-skills:composes:generate. -->

- `github-mcp-merge-pr#default`
- `github-mcp-pr-review-note#default`

## How it works

1. Supply `owner/name`, the exact pull-request number, exact comment body, and a
   stable idempotency key for that body.
2. The default `post` runner computes the body digest and admits the write only
   under a compatible `pr.comment` grant.
3. Native `provider.mutate` posts under `pr.comment`; native `provider.read`
   then reads the returned comment ref under `pr.read`. Repository, PR number,
   comment ref, and body digest must match before completion.
4. The explicit `comment` runner preserves the separately human-gated bundled
   `examples/github-mcp-hero/review-note` path as the canonical MCP composition
   and deterministic harness surface. It is not live Connect evidence.

The separate `merge-refused` runner routes the same comment grant to the
bundled `examples/github-mcp-hero/merge-pr` denial fixture. It is an executable
authority test: a `pr.merge` request must seal as policy denied, never as a
backdoor merge path.

## Stop conditions

- Stop when repository, pull-request number, body, or idempotency key is
  missing or changes after admission.
- The explicit `comment` runner stops when its human approval is absent or
  denied; the default `post` runner does not add that second gate.
- Refuse a provider grant that does not resolve uniquely to `pr.comment`.
- Refuse a missing, ambiguous, wrong-provider, or under-scoped GitHub binding;
  compatible local `gh`, hosted connectors, and MCP transports all remain
  behind the same provider effect rather than a raw token or package HTTP client.
- Do not treat mutation acceptance without an independent comment read, stable
  comment ref, and matching body digest as final readback.
- Never merge, close, label, or otherwise mutate the pull request beyond the
  exact comment.

## Example

An operator invokes `post` with “Please add the missing recovery fixture” for
PR 42 under a `pr.comment` grant. The skill posts exactly that body under the
stable retry key and seals the returned comment id. Changing the body changes
the operation identity. Attempting to reuse the comment grant for merge is
denied before GitHub mutation.
