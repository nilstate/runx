---
name: prospect-sequence
description: "Research an account through a governed, SSRF-guarded HTTP front over an explicit host allowlist, synthesize an angle that cites every source it read, draft a multi-touch outreach sequence, and emit a gated send proposal that the send-as catalog skill performs."
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
inputs:
  prospect:
    type: json
    required: true
    description: "Account identity: { company, contact, domain? }."
  icp:
    type: string
    required: true
    description: "Ideal customer profile / who we serve; shapes the angle."
  source_allowlist:
    type: json
    required: true
    description: "Permitted public hosts read through the governed HTTP front; every fetch is SSRF-guarded and re-checked on redirects."
runx:
  category: ops
links:
  source: https://github.com/epistemedeus/prospect-sequence
license: MIT
---

# Prospect Sequence

Turn an account plus an ICP into a **sourced** outreach plan: read only the
public sources you are allowed to read, build an angle you can defend line by
line, draft the touches, and hand the actual send to a gated downstream skill.

The judgment here is the research and the angle, not the send. This skill does
the judgment and refuses to fabricate. It never sends.

## What this skill does

1. Takes `prospect` (`{company, contact}`), an `icp`, and a `source_allowlist`.
2. For each allowlisted host, reads its public homepage through a **governed
   HTTP front**: every request and every redirect hop is checked against the
   allowlist and an **SSRF guard** that refuses loopback, private, link-local,
   unique-local, CGNAT, and cloud-metadata targets (e.g. `169.254.169.254`).
3. Extracts verifiable facts (title, meta/OG description, h1, or page text) and
   records each with the `source_url` it came from and a `content_digest`.
4. Synthesizes an **angle** whose every claim cites a source it actually read.
   If nothing readable was found, it **refuses** rather than invent account facts.
5. Drafts a **multi-touch sequence** (3 touches) where each touch cites the
   source fact it leans on.
6. Emits a **gated `send_proposal`**: `decision: proposed`, `requires_approval:
   true`, `performed_by: send-as`. The proposal is a proposed Effect only — the
   actual send is performed by the `send-as` catalog skill, never here.

## Typed inputs

- `prospect` (required): `{ company, contact, domain? }`.
- `icp` (required): who we are / who we serve; shapes the angle.
- `source_allowlist` (required): permitted public hosts. Each host's homepage is
  read through the governed front; off-allowlist or non-public targets are refused.

## Typed output

```yaml
decision: ready | refused
research:
  sources:                # only sources actually read
    - url: string
      host: string
      status: number
      content_digest: string   # sha256 over the retrieved body
      bytes: number
      redirects: array
      fetched_at: string
      fetched_facts: [ { kind, value } ]
  angle:
    statement: string     # every claim traceable to a cited source
    cited_sources: [string]
    facts_used: [ { source_url, kind, fact } ]
sequence:                 # multi-touch; each touch cites its source
  - { step, channel, day, to, subject, body, cites: [url] }
send_proposal:            # GATED proposed Effect, performed by send-as
  decision: proposed
  performed_by: send-as
  requires_approval: true
  channel, to, first_touch_ref, consent_basis, note
policy:
  allowlist: [string]
  ssrf_guard: enforced
  denied: [ { host, url, reason } ]   # off-allowlist / SSRF-refused targets
```

## Stop conditions (governed refusal)

- **No allowlisted host, or every candidate refused by the allowlist/SSRF guard:**
  `decision: refused`, no angle, no sequence, no proposal; `policy.denied`
  records each refusal reason. The run still seals — a provable refusal.
- **Off-allowlist redirect:** the hop is refused and the source is dropped.
- **Never fabricate:** an account fact that was not read from a cited source is
  never asserted.

## When to use

- You have an account and an ICP and want a defensible, sourced first-touch plan.
- You need the research bound to digests and source URLs so a reviewer (or a
  later send step) can trust it without re-reading.

## When not to use

- To actually send. That is the `send-as` catalog skill's gated Effect.
- To read a host the caller did not allowlist, or any non-public target.
- To reason over sources you could not read; it refuses instead of guessing.

## Worked example

`prospect={company:"Example Org", contact:"ops@example.com"}`,
`icp="B2B teams with a public site"`, `source_allowlist=["example.com"]` →
reads `https://example.com/`, extracts its title/description, builds an angle
citing that URL, drafts 3 touches, and proposes (not sends) the first one.
Swapping the allowlist to `["169.254.169.254"]` makes the SSRF guard refuse the
target, and the skill returns `decision: refused`.
