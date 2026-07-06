---
name: deliverability-judge
description: Fuse sealed sender-deliverability signals into a typed verdict plus an optional read-only recommendation without inventing or shipping state.
runx:
  category: operations
---

# Deliverability Judge

Deliverability Judge fuses four sealed deliverability signals (postmaster
report, bounce metrics, complaint metrics, placement probe) into a typed
verdict and, when the policy is satisfied and the signals agree, an optional
read-only recommendation. The skill is read-only. It mints no authority,
holds no state, and never opens an outbound effect.

The recommendation is a typed hint for a human operator or a downstream
deliverability lane. The skill never sends, throttles, suppresses, or moves
money. The T5 deliverability family owns any live throttle that consumes
this skill's verdict; this skill only emits the verdict and the optional
recommendation.

## Inputs

- `evidence` (required object): four sealed signal blocks.
  - `postmaster_report` (required object): a sealed postmaster status block
    with `status`, `source`, and `timestamp`.
  - `bounce_metrics` (required object): a sealed bounce-rate block with
    `bounce_pct`, `source`, and `timestamp`.
  - `complaint_metrics` (required object): a sealed complaint-rate block
    with `complaint_pct`, `source`, and `timestamp`.
  - `placement_probe` (required object): a sealed placement probe with
    `inbox_rate_pct`, `source`, and `timestamp`.
- `policy` (required object): signal bounds the operator is willing to
  accept.
  - `min_reputation_score` (required number): reputation threshold the
    postmaster report must meet or exceed.
  - `max_bounce_pct` (required number): maximum acceptable bounce rate.
  - `max_complaint_pct` (required number): maximum acceptable complaint
    rate.

## Output

- `verdict` (required object): `{state, confidence_window, reason}` where
  `state` is one of `healthy`, `at_risk`, or `contradictory`.
- `recommendation` (optional object): `{action, signal_bindings, evidence_hash}`
  where `action` is one of `continue` or `escalate_human_review`. Present
  only when the verdict is `healthy` AND every required signal agrees
  with the policy.
- `refusal` (optional object): present when the verdict is `at_risk` or
  `contradictory`. Includes the refusing reason and the names of the
  signals that disagreed or were missing.
- `evidence_hash` (optional string): a stable hash of the four sealed
  signal blocks, present on every verdict that successfully parsed the
  signal set.

## Rules

- Each input signal block must include `source` and `timestamp`; a missing
  source or timestamp is treated as an unsealed signal and forces the
  verdict to `contradictory` with a refusal.
- A signal value that exceeds its policy bound produces a verdict of
  `at_risk`; the recommendation is omitted and a refusal is emitted.
- Two signals in conflict (e.g. healthy reputation combined with a
  high bounce rate) produce a verdict of `contradictory`; the
  recommendation is omitted and a refusal is emitted.
- A partial signal set is never enough: at least one of `bounce_metrics`
  or `complaint_metrics` must be present together with the postmaster
  report, or the verdict is `contradictory` with a partial-set refusal.
- The recommendation is read-only. The skill never issues a send, a
  throttle, a suppression, or any other stateful effect.
- The skill never invents a signal that is not present in the input.
- The skill never echoes raw customer data, recipient lists, or any
  secret tokens into the verdict, the recommendation, or the refusal.
- Contradictory or unsealed signals escalate to a human reviewer via the
  `escalate_human_review` action or, when no recommendation is safe, via
  the explicit refusal.