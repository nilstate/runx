# Escalation Judge Harness Evidence

Package: `escalation-judge@0.1.0`

The inline harness covers:

- `escalation-judge-escalates-critical-churn`: critical severity and an
  explicit churn signal cross the named `high -> priority_support` policy
  threshold, emit `decision.escalate=true`, append `case_id`, and name
  `slack://support-priority`.
- `escalation-judge-no-change-low-risk`: low severity and no declared churn
  signal seal deterministically with `decision.escalate=false`, no packet, and
  `no_threshold_matched`.

Actual command output, receipt refs, registry URLs, PR URLs, and hosted harness
results are recorded in `evidence.json` and `verification.json` after publish.
