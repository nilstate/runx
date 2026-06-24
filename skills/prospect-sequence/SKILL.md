---
name: prospect-sequence
description: Research an account from allowlisted public sources and draft a sourced, gated outreach sequence without sending it.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
    require_enforcement: false
inputs:
  prospect:
    type: json
    required: true
    description: Prospect object with company and optional contact fields.
  icp:
    type: string
    required: true
    description: Ideal customer profile or sales hypothesis to test.
  source_allowlist:
    type: json
    required: true
    description: List of allowlisted public source URLs or hostnames.
runx:
  category: growth
  input_resolution:
    required:
      - prospect
      - icp
      - source_allowlist
---

# Prospect Sequence

`prospect-sequence` researches a target account through public, allowlisted
sources and produces a sourced outreach angle, a short multi-touch sequence, and
a gated send proposal. It never sends the message itself.

## Contract

- Inputs: `prospect{ company, contact }`, `icp`, and `source_allowlist`.
- Output: `research{ sources[], angle }`, `sequence[]`, and `send_proposal`.
- Every account fact used in the angle must cite a source that was read.
- If no allowlisted public source is available, or the target points to a
  private-network/off-allowlist URL, the skill refuses instead of fabricating.
- The `send_proposal` is a proposed effect for a downstream send-as catalog
  skill; it is not an email send.

## Safety boundary

The runner accepts only `https://` public sources whose host is explicitly
allowlisted. It blocks localhost, private IPs, link-local ranges, and hosts not
present in `source_allowlist`.
