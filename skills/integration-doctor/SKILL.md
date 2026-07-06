---
name: integration-doctor
description: Diagnose integration trace mismatches with cited request and response evidence, then emit a gated fix plan and issue proposal without making provider calls.
runx:
  category: ops
---

# Integration Doctor

Integration Doctor turns a bounded integration failure trace into a grounded
diagnosis. It compares the caller's integration spec, trace bundle, expected
contract, and incident context, then emits a root cause, evidence-backed fix
plan, escalation decision, and issue proposal when the evidence is actionable.

This skill does not call providers, retry webhooks, inspect live credentials,
open issues, or mutate any integration. It reads the supplied artifacts and
produces a handoff packet for a human or downstream issue-intake lane.

## What This Skill Does

1. **Validate evidence.** Refuse when the integration spec, expected contract,
   or trace bundle is missing, empty, or internally conflicting.
2. **Compare observed and expected behavior.** Check endpoint path, status,
   response shape, timestamp order, and declared auth mode against the expected
   contract.
3. **Cite trace evidence.** Every diagnosis cites request, response, or contract
   refs supplied by the caller. Redacted headers stay redacted.
4. **Emit a fix plan.** Actionable mismatches produce ordered remediation steps
   with owners and evidence refs.
5. **Gate downstream work.** The issue proposal is data for issue-intake or
   issue-to-pr. This skill opens nothing itself.

## Contract Boundaries

- **Typed inputs are required.**
  - `integration_spec`: provider, endpoints, auth mode, and integration owner.
  - `trace_bundle`: observed requests, responses, timestamps, and redaction
    metadata.
  - `expected_contract`: expected endpoints, statuses, and required fields.
  - `incident_context`: impact, environment, and caller objective.
- **Typed output is deterministic.** The output contains `diagnosis`,
  `fix_plan`, `escalation`, and `issue_proposal` when actionable.
- **No live operations.** The skill performs no provider calls, webhook retries,
  credential handling, account mutation, or issue creation.
- **No invented causes.** If evidence is missing or contradictory, the result is
  `needs_more_evidence` and no issue proposal is emitted.

## Refusals And Stops

- Missing requests, responses, expected endpoints, or integration spec returns a
  refused result.
- Conflicting responses for the same request without ordering evidence returns
  `needs_more_evidence`.
- Secret-like values are never echoed. Evidence refs name the location while
  keeping raw credential material out of output.
- Ambiguous traces escalate to a human with a specific evidence request.

## Quality Profile

- Purpose: produce a trusted first diagnosis for failed integrations.
- Audience: integration engineers, support escalations, and issue intake lanes.
- Artifact contract: diagnosis, cited evidence refs, fix plan, escalation
  decision, and optional issue proposal.
- Evidence bar: every root-cause claim points to supplied request, response, or
  contract evidence.
- Safety bar: no provider calls, no credential handling, no webhook retries, and
  no issue mutation.
- Stop conditions: missing evidence, contradictory trace data, unredacted secret
  values, or no mismatch found.

## Output Schema

```yaml
diagnosis:
  root_cause: string | null
  confidence: number
  evidence_refs:
    - string
  observed:
    endpoint: string
    status: number | null
    shape: string
fix_plan:
  - step: string
    owner: string
    evidence_refs:
      - string
escalation:
  decision: actionable | needs_more_evidence | no_issue
  lane: issue-intake | human-review | none
  reason: string
issue_proposal:
  title: string
  body: string
  labels:
    - string
```

## Inputs

- `integration_spec` (required): provider, endpoint definitions, auth mode, and
  owner.
- `trace_bundle` (required): requests, responses, timestamps, and redaction
  metadata.
- `expected_contract` (required): expected status and required response fields.
- `incident_context` (optional): environment, impact, and objective.
