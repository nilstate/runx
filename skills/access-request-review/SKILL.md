---
name: access-request-review
description: Review a bounded access request against policy and emit a least-privilege grant proposal or denial.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  input_mode: stdin
  cwd: .
  timeout_seconds: 30
inputs:
  access_request:
    type: json
    required: true
    description: Request packet with requester, requested resource, requested action, business justification, and optional ticket metadata.
  policy:
    type: json
    required: true
    description: Access policy with allowed roles, resources, actions, TTL caps, approval rules, and escalation rules.
  current_entitlements:
    type: json
    required: true
    description: Current role and grant state for the requester.
  objective:
    type: string
    required: false
    description: Optional operator intent for the review.
runx:
  category: security
  input_resolution:
    required:
      - access_request
      - policy
      - current_entitlements
---

# access-request-review

Use this skill when an operator needs a bounded access decision before a
human-approved one-time grant. The skill compares a request, the governing
policy, and current entitlements, then returns `grant`, `deny`, or
`needs_human_review`.

The skill never creates access, calls identity providers, sends approval
messages, stores credentials, or widens authority outside the supplied policy.
When access is allowed it emits a least-privilege grant proposal with a bounded
TTL, exact scope, approval gate, and evidence citations.

## Inputs

- `access_request`: requester id, role, action, resource, requested scope,
  justification, ticket id, and optional requested TTL.
- `policy`: allowed roles, resources, actions, maximum TTL, denied resources,
  sensitive resources, required approvals, and break-glass rules.
- `current_entitlements`: current grants and group/role state for the requester.
- `objective`: optional operator intent.

## Output

The runner returns JSON with:

- `decision_packet`: typed decision packet.
- `grant_proposal`: one-time proposal when the decision is `grant`.
- `evidence_json`: compact review evidence for external verification.
- `report`: human-readable review summary.

Decisions are deterministic and fail closed when request, policy, or entitlement
facts are missing.
