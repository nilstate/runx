---
name: agency-health
description: Fold one governed agency case stream into a read-only health verdict with grounded intervention findings.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 10
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  data_source_ref:
    type: string
    required: true
    description: Logical data-store source for the agency projection.
  store_id:
    type: string
    required: false
    description: Optional fixture or hosted data-store id.
  agency_ref:
    type: string
    required: true
    description: Domain-keyed agency reference.
  period:
    type: string
    required: false
    description: Window to grade, such as 7d.
  case_id:
    type: string
    required: false
    description: Optional agency case id.
  health_baseline:
    type: json
    required: false
    description: Optional thresholds for stuck turns, cap pressure, and refusal spike rate.
runx:
  category: ops
  input_resolution:
    required:
      - data_source_ref
      - agency_ref
---

# Agency Health

`agency-health` reads one standing agency case and returns a sealed, read-only
health bundle. It is for operators who need to know whether a governed agency is
moving, stuck, approaching its charter caps, or producing refusal spikes.

## What This Skill Does

1. Names the domain-keyed state read: `data-store.read_projection` over the
   agency case stream.
2. Names the cross-run aggregate read: ledger evidence by receipt id-stub only.
3. Folds the case projection in version order and grades only grounded signals.
4. Emits `health_verdict` and typed `intervention_findings`.
5. Routes findings by name to a downstream lane such as `policy-author`,
   `improve-skill`, or `human-ops`.

## Boundaries

- Read-only. It appends nothing, sends nothing, executes no rail, moves no
  money, and grants no access.
- Dispatch by naming only. An intervention finding is consumed only when a
  separate driver or operator issues a governed run.
- No ceilings or effect bounds are emitted because this skill owns no effect.
- Human ops is the escalation lane for critical findings and any remedy that
  would widen a cap or authority.

## Refusals

The skill stops with `needs_more_evidence` when no readable case events exist.
It refuses to grade a signal that is not grounded in the folded case projection
or in a ledger id-stub aggregate. It does not invent a cap, threshold, or turn
state absent from the charter snapshot, baseline, or sealed event order.

## Output

```yaml
decision: ready | needs_more_evidence | needs_human
health_verdict:
  status: healthy | watch | degraded | critical | unknown
  findings:
    - metric: seal_rate | stuck_case_count | cap_usage_pct | escalation_backlog
      value: string
      norm: string
      assessment: good | warning | critical | info
      grounding:
        case_id: string
        turns: [number]
        ledger_id_stubs: [string]
intervention_findings:
  - target_lane: policy-author | improve-skill | human-ops
    reason: string
    grounding_case_id: string
    grounding_turns: [number]
    ledger_id_stubs: [string]
    effect_bound: null
    ceiling: null
read_plan:
  domain_state_read: data-store.read_projection
  ledger_aggregate_read: ledger.read by receipt id-stub
```

## Fixture Mode

For public harnesses and adoption smoke tests, `data_source_ref=fixture://agency`
uses deterministic case streams shipped with the package. Hosted operators bind
the same typed inputs to their registry-pinned data-store projection and ledger
read runner.
