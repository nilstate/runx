---
name: receipt-review
description: Review receipts and harness failures to propose bounded skill improvements.
---

# Receipt Review

Diagnose what went wrong in a skill or chain execution and propose the
smallest change that fixes it.

Read the receipt or failure summary. Identify what was attempted, what
succeeded, and where it broke. The receipt contains step statuses
(`success`, `failure`, `policy_denied`, `missing_context`,
`approval_required`), exit codes, stderr, scope admission decisions,
and timing.

Distinguish root cause from symptoms. A chain may report failure at step 4,
but the root cause may be bad output from step 2 that propagated through
context passing. Trace data flow backward through context edges to find
where the problem originated.

Classify the failure:

- **Input error** — required input missing or malformed. Fix: input
  validation or input resolution.
- **Scope denial** — step requested scopes outside the chain grant.
  Fix: scope declarations or grant configuration.
- **Tool failure** — CLI tool or adapter returned an error. Fix: tool
  invocation (args, env, cwd) or the tool itself.
- **Schema mismatch** — step output did not match expected shape for
  downstream context. Fix: output parsing or artifact contract.
- **Timeout** — step exceeded time budget. Fix: increase timeout,
  reduce work, or split the step.
- **Policy denial** — transition gate blocked the step. Fix: gate
  conditions or upstream output.
- **Review rejection** — adversarial review found blocking issues.
  Fix: the code or spec, not the review process.
- **Harness assertion** — fixture expectations did not match actual
  output. Fix: skill logic or stale fixture expectations.

One failure, one fix. Propose the smallest change that addresses the root
cause. Do not bundle unrelated improvements.

## Output

- `verdict`: `pass`, `needs_update`, or `blocked`.
- `failure_summary`: which step, which failure class, what root cause.
  One to three sentences.
- `improvement_proposals`: array of bounded changes. Each:
  - `target`: what to change (SKILL.md, x.yaml, chain step, input, fixture)
  - `change`: what specifically to change
  - `rationale`: why this fixes the root cause
  - `risk`: what could go wrong
- `next_harness_checks`: replayable checks that should pass after the fix.

## Inputs

All optional — supply whichever evidence is available:

- `receipt_id`: receipt id to inspect.
- `receipt_summary`: sanitized receipt or harness summary.
- `harness_output`: failed harness output or assertion text.
- `skill_path`: path to the skill being improved.
