---
name: run-history
description: Produce one read-only report over runx's own run history, summarizing which skills run, how often they seal versus refuse, their maturity spread, and scope-usage patterns, with recommendations routed to the governance skills.
runx:
  category: data
---

# Run History Analyst

Turn runx's own run ledger into a governed, read-only report.

Every governed runx run leaves a receipt. Over time that ledger is data: which
skills run, how often they seal versus refuse, which never graduate past alpha,
and where authority is consistently broader than usage. This skill reads that
ledger (via `runx history` and `runx list`) and reports it. It never executes a
skill, sends, or mutates; every planned call is read-only. Its recommendations
route to the governance skills, `least-privilege`, `audit-receipt`,
and the maturity promoter, so the report turns into action through the right
governed lane.

## What this skill does

1. **Scope the question.** Account-wide, a single skill, or a period.
2. **Pull the ledger, read-only.** Plan `runx history` and `runx list` queries;
   never an execution command.
3. **Grade the signals.** Seal rate, refusal rate, maturity distribution, and
   scope-usage breadth, each with an assessment, not a bare number.
4. **Recommend through governed lanes.** A high refusal rate, a skill stuck at
   alpha, or a consistently-unused scope routes to a named governance skill, not
   a direct mutation.

## Core principles

- **Read-only.** Only `runx history` and `runx list`. No execution, send, or
  config call. Every planned call is `requires_confirmation: false`.
- **Grade, do not dump.** Every metric carries an assessment against a norm.
- **Route, do not act.** Recommendations name the governed lane
  (`least-privilege`, `audit-receipt`, maturity promoter); this skill
  does not change a grant or a tier itself.
- **Refusals are signal, not failure.** A healthy refusal rate means bounds are
  working; a spike means a skill or a policy needs review.
- **Absence is not health.** With no history, return `needs_more_evidence`.

## When to use this skill

- Periodic platform review: what is runx actually doing across skills.
- Spotting skills with anomalous refusal rates or stuck maturity.
- Finding consistently-unused scopes worth attenuating.

## When not to use this skill

- For a single run's authority audit (use `audit-receipt`).
- To narrow one skill's grant from its usage (use `least-privilege`).
- For email or product analytics. This reports on runx runs, not a domain
  dataset; that is a separate, product-owned analytics skill.

## Signals and norms

- `seal_rate`: share of runs that sealed cleanly. good >0.9, warning 0.7-0.9,
  critical <0.7.
- `refusal_rate`: share of runs that hit a governed refusal. info by default; a
  sharp per-skill spike is a warning worth routing.
- `maturity_distribution`: counts at alpha / beta / stable. Many skills stuck at
  alpha is a warning (no harness coverage).
- `scope_usage`: scopes granted but never exercised across runs, a candidate for
  attenuation.


## Output schema (`history_report`)

```yaml
decision: ready | needs_more_evidence
scope: workspace | skill | all
period: string
ordered_tool_calls:
  - tool: runx history | runx list
    purpose: string
    requires_confirmation: boolean      # always false; read-only
findings:
  - metric: string
    value: string
    assessment: good | warning | critical | info
recommendations:
  - finding: string
    lane: least-privilege | audit-receipt | maturity-promoter | none
    action: string
blockers: [string]
needs_input: [string]
success_checkpoint:
  milestone: string
  description: string
```

## Worked example

Question: "How is the skill catalog behaving this month?" The report plans
`runx history --since 30d` and `runx list skills --json`, then reports a 0.94
seal rate (good), a refusal rate of 0.06 (info, bounds working), a maturity
spread of 14 alpha / 5 beta / 2 stable (warning, most skills lack harness
coverage), and one skill granted `repo.write` but never exercising it across 40
runs. It recommends routing the alpha-heavy spread to the maturity promoter and
the unused `repo.write` to `least-privilege` for attenuation. It changes
nothing itself.

## Inputs

- `objective` (required): the history question.
- `scope` (optional): `workspace`, a specific `skill`, or `all`.
- `period` (optional): e.g. `30d` or `90d`.
- `history_summary` (optional): a sanitized `runx history` summary when already
  fetched.
- `objective` guides which signals to lead with.
