---
name: pr-review-note
description: Govern one GitHub pull-request review comment through Runx Connect or the canonical MCP pattern, with exact approval, retry safety, and independent readback.
runx:
  category: code
---

# PR Review Note

Post one bounded review comment to one known GitHub pull request. The skill is
deliberately narrower than a general GitHub operator: it binds approval to the
exact repository, pull request, and comment body, executes through a declared
provider boundary, and closes only when provider evidence identifies and reads
back the created note.

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
2. The default `connect-comment` runner computes the body digest and asks for
   human approval bound to the repository, PR, and digest.
3. Native `provider.mutate` posts under `pr.comment`; native `provider.read`
   then reads the returned comment ref under `pr.read`. Repository, PR number,
   comment ref, and body digest must match before completion.
4. The explicit `comment` runner preserves the bundled
   `examples/github-mcp-hero/review-note` path as the canonical MCP composition
   and deterministic harness surface. It is not live Connect evidence.

The separate `merge-refused` runner routes the same comment grant to the
bundled `examples/github-mcp-hero/merge-pr` denial fixture. It is an executable
authority test: a `pr.merge` request must seal as policy denied, never as a
backdoor merge path.

## Stop conditions

- Stop when repository, pull-request number, body, or idempotency key is
  missing or changes after approval.
- Stop when approval is absent or denied.
- Refuse a provider grant that does not resolve uniquely to `pr.comment`.
- Refuse a missing, ambiguous, wrong-provider, or under-scoped GitHub Connect
  grant rather than falling back to a raw token or package HTTP client.
- Do not treat mutation acceptance without an independent comment read, stable
  comment ref, and matching body digest as final readback.
- Never merge, close, label, or otherwise mutate the pull request beyond the
  exact comment.

## Example

An operator approves “Please add the missing recovery fixture” for PR 42. The
skill posts exactly that body under the stable retry key and seals the returned
comment id. Changing the body requires a new approval. Attempting to reuse the
comment grant for merge is denied before GitHub mutation.
