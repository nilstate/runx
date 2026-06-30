---
name: prospect-sequence
version: 0.1.0
description: Research a prospect from allowlisted public sources, synthesize a cited outreach angle, draft a multi-touch sequence, and emit only a gated send proposal.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/zdfgu113/runx/tree/codex/prospect-sequence/skills/prospect-sequence
runx:
  category: growth
  input_resolution:
    required:
      - prospect
      - icp
      - source_allowlist
---

# Prospect Sequence

Research a prospect from allowlisted public source snippets, synthesize a cited
account angle, draft a four-touch outreach sequence, and emit a gated
`send_proposal` for the `send-as` catalog skill. The skill never sends a
message, signs an external request, mutates a CRM, scrapes private networks, or
uses non-allowlisted sources.

## When to use this skill

Use it when an operator needs a checkable, source-backed outreach draft before a
human or governed send skill decides whether anything should be sent. The output
keeps every account-specific claim tied to a supplied public source URL.

## When not to use this skill

Do not use it for scraping, private-network targets, off-allowlist URLs,
unsourced account claims, spam sending, or bypassing consent and operator
approval. If no allowlisted public source is present, the skill refuses and emits
no send proposal.

## Procedure

1. Require typed inputs `prospect`, `icp`, and `source_allowlist`.
2. Accept only `http` or `https` source URLs whose host appears in
   `source_allowlist.allowed_hosts` when that list is supplied.
3. Refuse loopback, RFC1918, `.local`, non-HTTP, missing-text, or
   off-allowlist sources before using any account fact.
4. Extract account facts only from the accepted public source snippets.
5. Synthesize one outreach angle that cites the source URL used for the claim.
6. Draft a four-touch sequence that stays scoped to the cited public evidence.
7. Emit `send_proposal` only as a gated proposed Effect for `send-as`; the
   proposal records that this skill performs no send.
8. Refuse with `no_allowlisted_public_sources` when the source evidence is too
   thin or blocked by the SSRF guard.

## Output

The runner emits `runx.prospect_sequence.v1` with:

- `summary`: short decision summary.
- `research`: `{ sources[], angle }`, with source URLs and extracted facts.
- `sequence`: ordered outreach touches.
- `send_proposal`: gated proposal for `send-as`, or `null` on refusal.
- `refusal`: refusal reason and blocked source details when applicable.

## Example

```bash
runx skill ./skills/prospect-sequence \
  --input-json prospect='{"company":"Northwind Software","contact":"Head of Platform"}' \
  --input-json icp='{"product":"Runx governed agent workflows","audience":"platform and security operators","pain_points":["manual release evidence review"],"value_props":["produce sealed evidence packets before operational changes"]}' \
  --input-json source_allowlist='{"allowed_hosts":["example.com"],"sources":[{"url":"https://example.com/northwind-release-notes","title":"Northwind release notes","text":"Northwind Software described manual release evidence review in its public release notes."}]}' \
  --json
```

## Inputs

- `prospect` (required): object with `company` and optional `contact` or `role`.
- `icp` (required): object with `product`, `audience`, `pain_points`, and
  `value_props`.
- `source_allowlist` (required): object with `allowed_hosts` and `sources[]`.
  Each source must include `url`, `title`, and public source `text`.

## Safety Notes

- The runner is deterministic over supplied source snippets; a consuming product
  can hydrate those snippets through its governed HTTP front.
- The SSRF guard rejects private, loopback, local, off-allowlist, or non-HTTP
  targets.
- The `send_proposal` is not a send. It is a gated effect proposal that a
  separate `send-as` skill must review and execute only with policy approval.
