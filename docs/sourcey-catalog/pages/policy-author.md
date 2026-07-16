# policy-author

- Group: Safety and review
- Source: [skills/policy-author/SKILL.md](https://github.com/runxhq/runx/blob/5afc25a83edf1c1320df7ac0d78c36f1523b5677/skills/policy-author/SKILL.md)
- Commit: `5afc25a83edf1c1320df7ac0d78c36f1523b5677`
- Path: `skills/policy-author/SKILL.md`

# Policy Author

Author one governed runx operational policy from intent, and prove it lints.

Adopting governed runx means writing an operational policy: which repos may be
touched, who owns which surface, which sources are trusted, what confidence is
required before action, and which outcomes need a human. Written by hand that is
a long, error-prone document. This skill turns a plain-English governance brief
into one `runx.operational_policy.v1` proposal, or tightens an existing policy,
and runs a fail-closed lint over it before it ships. It proposes; a human
approves.

## What this skill does

1. **Read the intent.** Take the governance brief (and an existing policy when
   tightening) and identify the target surfaces, sources, owners, and the risk
   posture.
2. **Draft the policy.** Produce a complete `runx.operational_policy.v1`: target
   repos, runner binding, allowed actions, trusted sources with confidence
   floors, owner routes, and outcome rules.
3. **Lint fail-closed.** Run the policy checks below. Any failing check blocks
   the proposal with the exact fix, rather than shipping a permissive policy.
4. **Tighten, never loosen.** When given an existing policy, only propose
   changes that narrow authority (auto-merge off, human gate on, confidence up).
   Widening is a separate, explicit human decision.

## Core principles

- **Fail closed.** Unspecified means denied. A missing owner route, source rule,
  or confidence floor is a lint error, not a permissive default.
- **Human gate on mutation.** Any policy that allows repository mutation must set
  `require_human_merge_gate: true` and `auto_merge: false`.
- **Named owners.** Every target surface routes to a named owner; no orphan
  surfaces.
- **Bounded sources.** Each trusted source declares a minimum confidence; no
  source admits work below its floor.
- **Verification before close.** A source issue closes only when the outcome is
  verified.

## When to use this skill

- Bootstrapping a new runx deployment that needs an operational policy.
- Tightening an existing policy after a near-miss or an audit.
- Onboarding a new target repo, source, or owner into an existing policy.

## When not to use this skill

- To widen authority (add auto-merge, drop a human gate, lower confidence). That
  is an explicit human decision, not a generated proposal.
- To write skill logic or graphs. This authors the governance envelope, not the
  skills it governs.

## The operational policy model

The proposal fills `runx.operational_policy.v1`:

- `target_repos`: the repositories the policy may act on.
- `runner`: the runner binding (id, kind, and required substrate, e.g. GitHub
  Actions + scafld).
- `allowed_actions`: the lanes permitted (e.g. `issue-intake`, `issue-to-pr`,
  `pr-review`).
- `sources`: trusted inbound sources, each with a `min_confidence` floor.
- `owner_routes`: surface-to-owner routing; every surface has a named owner.
- `outcomes`: `verification_required`, `close_source_issue`,
  `require_human_merge_gate`, `auto_merge`.

## Lint diagnostics

The fail-closed lint emits these; any error blocks the proposal:

- `policy.owner.unrouted` (error): a target surface has no owner route.
- `policy.mutation.no_human_gate` (error): mutation allowed without
  `require_human_merge_gate: true`.
- `policy.mutation.auto_merge_on` (error): `auto_merge` is true on a mutating
  policy.
- `policy.source.no_confidence_floor` (error): a source has no `min_confidence`.
- `policy.source.floor_too_low` (warning): a confidence floor below 0.7.
- `policy.close.before_verify` (error): `close_source_issue` set without
  `verification_required`.
- `policy.action.unknown` (error): an allowed action is not a known lane.

## Procedure

1. Validate that the brief names the governed work, the target repo or surface,
   and the intended owner or escalation route.
2. Extract all repos, sources, actions, owners, confidence floors, and outcome
   rules from the brief and any existing policy.
3. If tightening an existing policy, diff proposed changes against the current
   grant. Flag any widened action, lower confidence floor, removed owner, or
   removed human gate as a separate human decision.
4. Draft the smallest complete `runx.operational_policy.v1` that allows the
   stated work and denies everything else.
5. Run the lint diagnostics. Any `error` finding prevents `decision: ready`.
6. Emit the policy, lint result, rationale, blockers, and success checkpoint.

## Edge cases and stop conditions

- **No owner route:** return `needs_input`; an ownerless surface is never
  governed by default.
- **Mutation without a human gate:** return `reject` or `needs_input`; do not
  emit a ready mutating policy without `require_human_merge_gate: true`.
- **Auto-merge requested:** block the proposal unless the user explicitly
  performs a separate authority-widening decision outside this skill.
- **Unknown action lane:** return `needs_input` with the unknown action names.
- **Source without confidence floor:** return `needs_input`; implicit trust is
  not a policy.
- **Conflicting owner routes:** return `needs_input` and cite the conflicting
  surfaces and owners.

## Output schema (`policy_proposal`)

```yaml
decision: ready | needs_input | reject
policy:
  schema: runx.operational_policy.v1
  target_repos: [string]
  runner:
    id: string
    kind: string
    requires: [string]
  allowed_actions: [string]
  sources:
    - provider: string
      min_confidence: number
  owner_routes:
    - surface: string
      owner: string
  outcomes:
    verification_required: boolean
    close_source_issue: never | when_verified | always
    require_human_merge_gate: boolean
    auto_merge: boolean
lint:
  status: pass | fail
  findings:
    - id: string
      severity: error | warning
      message: string
rationale: string
blockers: [string]
needs_input: [string]
success_checkpoint:
  milestone: string
  description: string
```

A proposal with any `error` finding must have `decision: needs_input` or
`reject`, never `ready`.

## Worked example

Brief: "Govern issue intake across our three repos. GitHub issues and Sentry
alerts. Kam owns the platform, Chong owns product. Never auto-merge; a human
approves every merge; close the source issue only once the fix is verified."

The proposal binds the three repos to a GitHub-Actions + scafld runner, allows
`issue-intake`/`issue-to-pr`/`pr-review`, trusts GitHub at 0.72 and Sentry at
0.82, routes platform to Kam and product to Chong, and sets
`require_human_merge_gate: true`, `auto_merge: false`,
`verification_required: true`, `close_source_issue: when_verified`. The lint
passes, so `decision: ready`.

## Inputs

- `governance_brief` (required): the governance intent in prose.
- `existing_policy` (optional): a current `runx.operational_policy.v1` to tighten.
- `target_repos` (optional): explicit repo list when not in the brief.
- `objective` (optional): operator intent that focuses the pass.
