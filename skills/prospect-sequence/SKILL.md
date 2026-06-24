---
name: prospect-sequence
description: Research a public prospect from allowlisted sources and draft a cited outreach sequence with a gated send-as proposal.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  tags:
    - account-research
    - outreach
    - sequence
links:
  catalog_pair: send-as
---

# Prospect Sequence

This skill turns a bounded public account research request into a sourced
outreach angle, a short sequence, and a gated `send_proposal` for the canonical
`send-as` catalog skill. It is designed for account research where every claim
must come from caller-supplied or allowlisted public sources.

## When to use

Use this skill when you have a named company/contact, an ideal customer profile,
and a strict list of public source hosts that may be read. The skill is useful
for preparing an account-specific outreach draft while keeping live sending
behind a separate approval and `send-as` authority gate.

## Inputs

- `prospect`: JSON object with `company`, optional `contact`, and
  `public_sources[]`. Each source has a public `url`; deterministic harness
  sources may include bounded `content`.
- `icp`: JSON object or string describing target fit, pains, offer, proof, and
  tone.
- `source_allowlist`: JSON array of hostnames the research step may read.

## Output

The skill emits `prospect_sequence_packet.v1`:

- `research.sources[]`: each public source read, with host, citation id, and
  evidence snippets.
- `research.angle`: a sourced outreach angle with citations for every source
  used.
- `sequence[]`: a three-step email sequence grounded in the cited research.
- `send_proposal`: a proposed Effect for `send-as`; it does not send.
- `refusal`: present when the input has no usable public source, an off-
  allowlist URL, private-network URL, or unsupported scheme.

## Procedure

1. Validate `prospect.company`, `icp`, `public_sources[]`, and
   `source_allowlist`.
2. Refuse private-network, localhost, non-HTTP(S), or off-allowlist URLs before
   any read.
3. Read only the approved public sources. Fixture content is accepted for
   deterministic harnesses; otherwise the runner uses bounded HTTP fetches.
4. Extract short evidence snippets from the source text without inventing facts.
5. Build one outreach angle that cites every source used.
6. Draft a three-message sequence that only repeats facts present in citations.
7. Emit a `send_proposal` as a gated `send-as` Effect. Live delivery remains
   outside this skill.

## Safety boundaries

This skill never sends email, posts messages, mutates a CRM, buys data, scrapes
private networks, follows off-allowlist targets, or fabricates prospect facts.
If the available public evidence is too thin, it refuses instead of filling gaps
with guesses. The `send_proposal` is a proposal only; execution requires
`send-as` with the appropriate principal, audience, content digest, consent
basis, and human approval.
