---
name: prospect-sequence
description: Research an account from allowlisted public sources and draft a gated outreach sequence.
metadata:
  category: sales
  tags:
    - prospecting
    - outreach
    - research
---

# Prospect Sequence

`prospect-sequence` turns bounded public account research into a sourced sales
angle, a short multi-touch outreach sequence, and a gated `send-as` proposal. It
is for operators who need the judgment and evidence behind an AI SDR motion
without allowing the skill to send anything itself.

## When To Use

Use this skill when:

- You have a named prospect company and contact reference.
- You can provide public source snippets from an explicit allowlist.
- You need a reviewable outreach angle and sequence before a human or provider
  adapter sends.

Do not use it to scrape private networks, infer facts without source evidence,
or send messages directly.

## Inputs

- `prospect` (required): object with `company` and optional `contact`.
- `icp` (required): object describing the target customer profile, pain, and
  offer.
- `source_allowlist` (required): list of permitted hosts or URL prefixes.
- `sources` (required): public source objects with `url`, `title`, and
  `excerpt`. Every source URL must match the allowlist.

## Outputs

- `research`: object with `sources[]` and `angle`.
- `sequence`: array of outreach touches with channel, subject, body, and source
  citations.
- `send_proposal`: gated proposed Effect for `send-as`.

## Guardrails

1. Treat `source_allowlist` as the network boundary. Reject private or
   off-allowlist URLs before synthesizing.
2. Refuse when no source is available; the skill does not fabricate account
   facts.
3. Cite each source used in the angle and sequence.
4. Emit only a proposed `send-as` effect with `approval_required: true` and
   `sends_directly: false`.
5. Keep output deterministic enough for harness replay.

## Example

Input:

```yaml
prospect:
  company: Acme Logistics
  contact: VP Operations
icp:
  offer: governed agent workflows for operations teams
  pain: manual exception handling across support and finance
source_allowlist:
  - acme.example
sources:
  - url: https://acme.example/blog/exception-ops
    title: Exception operations update
    excerpt: Acme describes new SLA pressure from invoice and shipment exceptions.
```

Output:

```yaml
research:
  angle: Acme's public operations update shows SLA pressure around invoice and
    shipment exceptions, which maps to governed workflow automation.
sequence:
  - step: 1
    channel: email
    subject: Reducing exception-handling drag at Acme
send_proposal:
  effect: send-as
  gated: true
  approval_required: true
```

## Failure Modes

- No public sources: return `decision.status: refused`.
- Off-allowlist or private-network URL: return `decision.status:
  policy_denied`.
- Missing prospect or ICP: return `decision.status: refused`.
